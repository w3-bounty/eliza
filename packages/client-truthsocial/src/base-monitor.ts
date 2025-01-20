import { elizaLogger, stringToUuid, State, Memory, getEmbeddingZeroVector, IImageDescriptionService, ServiceType, composeContext, generateTweetActions, generateText, ModelClass, UUID, IAgentRuntime, ActionResponse } from "@elizaos/core";
import { ClientBase } from "./base";
import { TruthSocialConfig } from "./environment";
import { TruthSocialPost, TruthSocialAccount, TruthSocialActionResponse } from "./types";
import { processContent } from "./utils/content";
import { truthSocialMessageTemplate, truthSocialActionTemplate } from "./templates";

export abstract class BaseMonitorClient extends ClientBase {
    protected isProcessing: boolean = false;
    protected processedItems: Set<string> = new Set();
    private checkInterval: NodeJS.Timeout | null = null;
    protected abstract readonly clientType: 'notifications' | 'search';

    constructor(runtime: IAgentRuntime, config: TruthSocialConfig) {
        super(runtime, config);
    }

    protected abstract checkItems(): Promise<void>;

    // Helper function to check if error is group related
    protected isGroupError(error: any): boolean {
        return error?.response?.status === 404 &&
               (error?.response?.data?.error_code === 'GROUP_NOT_FOUND' ||
                error?.message?.includes('GROUP_NOT_FOUND') ||
                error?.message?.includes('You cannot post to this group'));
    }

    protected async handleFavourite(post: TruthSocialPost): Promise<boolean> {
        elizaLogger.log(`Favouriting post ${post.id}`);
        try {
            await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/favourite`, 'POST');
            elizaLogger.log(`Successfully favourited post ${post.id}`);
            return true;
        } catch (error) {
            if (this.isGroupError(error)) {
                elizaLogger.log(`Post ${post.id} is in a group, skipping favourite action`);
            } else {
                elizaLogger.error(`Failed to favourite post ${post.id}: ${error.message}`);
            }
            return false;
        }
    }

    protected async handleReblog(post: TruthSocialPost): Promise<boolean> {
        elizaLogger.log(`Reblogging post ${post.id}`);
        try {
            await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/reblog`, 'POST');
            elizaLogger.log(`Successfully reblogged post ${post.id}`);
            return true;
        } catch (error) {
            if (this.isGroupError(error)) {
                elizaLogger.log(`Post ${post.id} is in a group, skipping reblog action`);
            } else {
                elizaLogger.error(`Failed to reblog post ${post.id}: ${error.message}`);
            }
            return false;
        }
    }

    protected async handleQuote(
        post: TruthSocialPost,
        username: string,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string | null> {
        elizaLogger.log(`Generating quote for post ${post.id}`);
        try {
            const quoteContent = await this.generateContent(post, username, 'QUOTE', imageDescriptions, roomId);
            if (quoteContent) {
                await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                    status: quoteContent,
                    quote_id: post.id
                });
                elizaLogger.log(`Successfully posted quote for ${post.id}`);
                return quoteContent;
            }
        } catch (error) {
            if (this.isGroupError(error)) {
                elizaLogger.log(`Post ${post.id} is in a group, skipping quote action`);
            } else {
                elizaLogger.error(`Failed to post quote for ${post.id}: ${error.message}`);
            }
        }
        return null;
    }

    protected async handleReply(
        post: TruthSocialPost,
        username: string,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string | null> {
        elizaLogger.log(`Generating reply for post ${post.id}`);
        try {
            const replyContent = await this.generateContent(post, username, 'REPLY', imageDescriptions, roomId);
            if (replyContent) {
                await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                    status: replyContent,
                    in_reply_to_id: post.id
                });
                elizaLogger.log(`Successfully posted reply to ${post.id}`);
                return replyContent;
            }
        } catch (error) {
            if (this.isGroupError(error)) {
                elizaLogger.log(`Post ${post.id} is in a group, skipping reply action`);
            } else {
                elizaLogger.error(`Failed to post reply to ${post.id}: ${error.message}`);
            }
        }
        return null;
    }

    protected async handlePostActions(
        post: TruthSocialPost,
        username: string,
        truthSocialResponse: TruthSocialActionResponse,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string[]> {
        const executedActions: string[] = [];
        let isGroupPost = false;

        // Store the original post first
        await this.storeInMemory({
            id: post.id,
            roomId,
            content: post.content,
            metadata: {
                id: post.id,
                username,
                created_at: post.created_at,
                media_attachments: post.media_attachments,
                image_descriptions: imageDescriptions,
                type: 'original_post'
            },
            source: 'truthsocial',
            createdAt: post.created_at
        });

        // Handle favourite action
        if (truthSocialResponse.favourite) {
            const success = await this.handleFavourite(post);
            if (success) {
                executedActions.push('FAVOURITE');
            } else if (this.isGroupError({})) {
                isGroupPost = true;
            }
        }

        // Handle reblog action
        if (truthSocialResponse.reblog && !isGroupPost) {
            const success = await this.handleReblog(post);
            if (success) {
                executedActions.push('REBLOG');
            } else if (this.isGroupError({})) {
                isGroupPost = true;
            }
        }

        // If it's a group post, skip quote and reply actions
        if (isGroupPost) {
            elizaLogger.log(`Post ${post.id} is in a group, skipping quote and reply actions`);
            return executedActions;
        }

        // Handle quote action
        if (truthSocialResponse.quote) {
            const quoteContent = await this.handleQuote(post, username, imageDescriptions, roomId);
            if (quoteContent) {
                executedActions.push('QUOTE');
                // Store the quote response
                await this.storeInMemory({
                    id: `${post.id}-quote`,
                    roomId,
                    content: quoteContent,
                    metadata: {
                        id: post.id,
                        username,
                        type: 'quote_response',
                        original_post: post.content
                    },
                    source: 'truthsocial',
                    createdAt: Date.now()
                });
            }
        }

        // Handle reply action
        if (truthSocialResponse.reply) {
            const replyContent = await this.handleReply(post, username, imageDescriptions, roomId);
            if (replyContent) {
                executedActions.push('REPLY');
                // Store the reply response
                await this.storeInMemory({
                    id: `${post.id}-reply`,
                    roomId,
                    content: replyContent,
                    metadata: {
                        id: post.id,
                        username,
                        type: 'reply_response',
                        original_post: post.content
                    },
                    source: 'truthsocial',
                    createdAt: Date.now()
                });
            }
        }

        return executedActions;
    }

    public async start() {
        // Get the appropriate check interval based on the client type
        const intervalMinutes = this.clientType === 'notifications'
            ? this.config.TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL
            : this.config.TRUTHSOCIAL_SEARCH_CHECK_INTERVAL;

        // Convert minutes to milliseconds
        const checkIntervalMs = intervalMinutes * 60 * 1000;

        elizaLogger.log(`Starting ${this.clientType} monitor with ${intervalMinutes} minute check interval`);

        // Initial check
        await this.checkItems();

        // Set up periodic checking
        this.checkInterval = setInterval(() => {
            this.checkItems().catch(error => {
                elizaLogger.error("Error in check interval:", error);
            });
        }, checkIntervalMs);
    }

    public async stop() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
        await this.cleanup();
    }

    protected async processMediaAttachments(mediaList: any[], imageDescriptions: any[], itemId: string) {
        if (!mediaList || mediaList.length === 0) {
            elizaLogger.debug(`No media attachments found for item ${itemId}`);
            return;
        }

        elizaLogger.log(`Processing ${mediaList.length} media attachments for item ${itemId}`);
        elizaLogger.log(`TRUTHSOCIAL_PROCESS_IMAGES is ${this.config.TRUTHSOCIAL_PROCESS_IMAGES ? 'enabled' : 'disabled'}`);

        for (const media of mediaList) {
            elizaLogger.log(`Processing media type: ${media.type} with URL: ${media.url}`);
            if (media.type === 'image') {
                try {
                    elizaLogger.log(`Attempting to describe image from URL: ${media.url}`);
                    const description = await this.imageDescriptionService.describeImage(media.url);
                    elizaLogger.log(`Successfully got description for image ${media.id}: ${JSON.stringify(description)}`);
                    if (description) {
                        imageDescriptions.push({
                            mediaId: media.id,
                            url: media.url,
                            description
                        });
                    }
                } catch (error) {
                    elizaLogger.error(`Failed to process image ${media.id} in item ${itemId}: ${error.message}`, error);
                }
            } else {
                elizaLogger.debug(`Skipping non-image media type: ${media.type}`);
            }
        }

        elizaLogger.log(`Finished processing media attachments. Found ${imageDescriptions.length} image descriptions`);
    }

    protected async generateContent(
        post: TruthSocialPost,
        username: string,
        action: string,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string | null> {
        try {
            if (!post?.content?.trim()) {
                elizaLogger.warn(`Empty post content for ${post.id}, skipping content generation`);
                return null;
            }

            const { processedContent, isSummarized } = await processContent(post.content, this.runtime);

            // Check for empty content early
            if (!processedContent?.trim()) {
                elizaLogger.warn(`Empty processed content for post ${post.id}, skipping content generation`);
                return null;
            }

            const contentPrefix = isSummarized ? "[Summarized] " : "";
            const postContent = `ID: ${post.id}\nFrom: ${username}\nText: ${contentPrefix}${processedContent}`;

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: postContent, // Use the full formatted content
                        action
                    },
                },
                {
                    currentPost: postContent,
                    imageDescriptions: imageDescriptions.length > 0
                        ? `\nImages in Post:\n${imageDescriptions.map((desc, i) =>
                            `Image ${i + 1}: ${desc.description}`).join("\n\n")}`
                        : "",
                    action
                }
            );

            const context = composeContext({
                state,
                template: truthSocialMessageTemplate,
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!response?.trim()) {
                elizaLogger.warn(`Empty response generated for post ${post.id}`);
                return null;
            }

            // Enhanced moderation check
            const moderationPhrases = [
                // Direct refusals
                "I apologize",
                "I do not feel comfortable",
                "I cannot generate",
                "I cannot produce",
                "I cannot participate",
                "cannot assist",
                "unable to help",
                "against my principles",
                "[NO_ACTION]",
                "NO_ACTION",
                "NO_CONTENT",
                // Character-specific refusals
                "falls outside my area of expertise",
                "outside my areas of expertise",
                "not within my expertise",
                "not qualified to",
                "do not feel qualified",
                "must refrain from",
                "as a protocol droid",
                "my knowledge is limited to",
                "my programming does not",
                "I am not programmed to",
                // Topic-specific refusals
                "cannot engage with",
                "cannot endorse",
                "cannot comment on",
                "should not comment on",
                "must emphasize the importance",
                "while I aim to be helpful",
                "perhaps I could be of assistance with",
                "I would prefer not to",
                "it would be inappropriate",
                "not appropriate for me"
            ];

            const hasModeration = moderationPhrases.some(phrase =>
                response.toLowerCase().includes(phrase.toLowerCase())
            );

            if (hasModeration) {
                elizaLogger.log(`Skipping response due to moderation/refusal content for ${post.id}`);
                return null;
            }

            return response;
        } catch (error) {
            elizaLogger.error(`Failed to generate ${action} content: ${error.message}`);
            return null;
        }
    }

    public async cleanup() {
        await this.stop();
        this.processedItems.clear();
    }

    protected async storeInMemory({
        id,
        roomId,
        content,
        metadata,
        source,
        createdAt
    }: {
        id: string,
        roomId: UUID,
        content: string,
        metadata: any,
        source: 'truthsocial' | 'truthsocial_notification',
        createdAt: string | number
    }) {
        const memoryId = stringToUuid(id + "-" + this.runtime.agentId);

        // Ensure we have valid content before processing
        if (!content?.trim()) {
            elizaLogger.warn(`Empty content for memory ${memoryId}, skipping storage`);
            return;
        }

        // Process the content
        const { processedContent, isSummarized } = await processContent(content, this.runtime);

        // Double check processed content
        if (!processedContent?.trim()) {
            elizaLogger.warn(`Empty processed content for memory ${memoryId}, skipping storage`);
            return;
        }

        // Create the memory with the processed content
        await this.runtime.messageManager.createMemory({
            id: memoryId,
            userId: this.runtime.agentId,
            agentId: this.runtime.agentId,
            roomId,
            content: {
                text: processedContent,
                action: metadata.executedActions?.join(',') || 'NONE',
                source,
                metadata: {
                    ...metadata,
                    is_summarized: isSummarized,
                    original_content: content // Store original content for reference
                }
            },
            embedding: getEmbeddingZeroVector(),
            createdAt: typeof createdAt === 'string' ? new Date(createdAt).getTime() : createdAt
        });

        // Mark item as processed after successful storage
        this.processedItems.add(id);
        elizaLogger.debug(`Stored ${source} ${id} in memory with content length: ${processedContent.length}`);
    }
}