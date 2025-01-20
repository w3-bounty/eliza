import {
    elizaLogger,
    stringToUuid,
    getEmbeddingZeroVector,
    composeContext,
    generateTweetActions,
    generateText,
    ModelClass,
    UUID,
    IAgentRuntime,
} from "@elizaos/core";
import { TruthSocialConfig } from "./environment";
import {
    TruthSocialPost,
    TruthSocialAccount,
    TruthSocialActionResponse,
    TruthSocialSearchOptions,
    TruthSocialTimelineOptions,
    TruthSocialUser
} from "./types";
import { truthSocialSummarizationTemplate } from "./utils/content";

import { truthSocialMessageTemplate, truthSocialActionTemplate } from "./templates";
import { BaseMonitorClient } from "./base-monitor";

export class SearchClient extends BaseMonitorClient {
    private lastCheckedPosts: Map<string, string> = new Map();
    private actedOnPosts: Set<string> = new Set(); // Track posts we've taken actions on
    protected readonly clientType = 'search' as const;

    constructor(runtime: IAgentRuntime, config: TruthSocialConfig) {
        super(runtime, config);
    }

    async searchUsers(query: string, limit: number = 40): Promise<TruthSocialUser[]> {
        try {
            const response = await this.makeAuthenticatedRequest('/v2/search', 'GET', {
                q: query,
                type: 'accounts',
                limit,
                resolve: true
            });
            elizaLogger.log(`Found ${response.accounts?.length || 0} users matching "${query}"`);
            return response.accounts || [];
        } catch (error) {
            elizaLogger.error(`User search failed for "${query}": ${error.message}`);
            throw error;
        }
    }

    async getUserTimeline(username: string, options: TruthSocialTimelineOptions = {}): Promise<TruthSocialPost[]> {
        try {
            // First lookup the user ID
            const user = await this.makeAuthenticatedRequest('/v1/accounts/lookup', 'GET', {
                acct: username.replace('@', '')
            });

            if (!user) {
                elizaLogger.error(`User ${username} not found`);
                return [];
            }

            if (!user.id) {
                elizaLogger.error(`Invalid user response for ${username}`);
                return [];
            }

            const params = {
                exclude_replies: true,
                only_replies: false,
                with_muted: true,
                limit: options.limit ?? 20
            };

            if (options.max_id && options.max_id !== 'undefined') {
                params['max_id'] = options.max_id;
            }

            const response = await this.makeAuthenticatedRequest(
                `/v1/accounts/${user.id}/statuses`,
                'GET',
                params
            );

            if (!Array.isArray(response)) {
                elizaLogger.error(`Invalid posts response for ${username}`);
                return [];
            }

            return response;
        } catch (error) {
            elizaLogger.error(`Failed to fetch timeline for ${username}: ${error.message}`);
            return [];
        }
    }

    async searchPosts(query: string, limit: number = 40): Promise<TruthSocialPost[]> {
        try {
            const response = await this.makeAuthenticatedRequest('/v2/search', 'GET', {
                q: query,
                type: 'statuses',
                limit,
                resolve: true
            });
            elizaLogger.log(`Found ${response.statuses?.length || 0} posts matching "${query}"`);
            return response.statuses || [];
        } catch (error) {
            elizaLogger.error(`Post search failed for "${query}": ${error.message}`);
            throw error;
        }
    }

    private async summarizePost(content: string): Promise<string> {
        try {
            if (!content?.trim()) {
                elizaLogger.warn("Empty content provided for summarization");
                return "";
            }

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId: stringToUuid("summarization"),
                    agentId: this.runtime.agentId,
                    content: {
                        text: content,  // Pass the actual content
                        action: "SUMMARIZE"
                    },
                },
                {
                    content: content,  // Pass the actual content here too
                    originalLength: content.length,
                    summaryRequest: "Please provide a concise summary of this content while preserving key information."
                }
            );

            const context = composeContext({
                state,
                template: truthSocialSummarizationTemplate,
            });

            const summary = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (!summary?.trim()) {
                elizaLogger.warn("Empty summary generated, returning original content");
                return content;
            }

            return summary;
        } catch (error) {
            elizaLogger.error(`Failed to summarize post: ${error.message}`);
            return content;
        }
    }

    private async processPostContent(post: TruthSocialPost): Promise<{
        processedContent: string;
        isSummarized: boolean;
    }> {
        const cleanedContent = post.content;
        return {
            processedContent: cleanedContent,
            isSummarized: false
        };
    }

    protected async generateContent(
        post: TruthSocialPost,
        username: string,
        action: string,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string | null> {
        try {
            const { processedContent, isSummarized } = await this.processPostContent(post);
            const contentPrefix = isSummarized ? "[Summarized] " : "";
            const postContent = `ID: ${post.id}\nFrom: ${username}\nText: ${contentPrefix}${processedContent}`;

            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: postContent,
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
                template: this.runtime.character.templates?.messageHandlerTemplate || truthSocialMessageTemplate,
            });

            const response = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL,
            });

            if (response) {
                // Validate response doesn't contain moderation messages
                const moderationPhrases = [
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
                    "NO_CONTENT"
                ];

                const hasModeration = moderationPhrases.some(phrase =>
                    response.toLowerCase().includes(phrase.toLowerCase())
                );

                if (hasModeration) {
                    elizaLogger.log(`Skipping response due to moderation content for ${post.id}`);
                    return null;
                }

                return response;
            }
            return null;
        } catch (error) {
            elizaLogger.error(`Failed to generate ${action} content: ${error.message}`);
            return null;
        }
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

        // Handle favourite action
        if (truthSocialResponse.favourite) {
            elizaLogger.debug(`Attempting to favourite post ${post.id}`);
            try {
                await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/favourite`, 'POST');
                elizaLogger.log(`✓ Favourited post ${post.id}`);
                executedActions.push('FAVOURITE');
            } catch (error) {
                if (this.isGroupError(error)) {
                    isGroupPost = true;
                    elizaLogger.debug(`Post ${post.id} is in a group, skipping favourite action`);
                } else {
                    elizaLogger.error(`Failed to favourite post ${post.id}: ${error.message}`);
                }
            }
        }

        // Handle reblog action
        if (truthSocialResponse.reblog && !isGroupPost) {
            elizaLogger.debug(`Attempting to reblog post ${post.id}`);
            try {
                await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/reblog`, 'POST');
                elizaLogger.log(`✓ Reblogged post ${post.id}`);
                executedActions.push('REBLOG');
            } catch (error) {
                if (this.isGroupError(error)) {
                    isGroupPost = true;
                    elizaLogger.debug(`Post ${post.id} is in a group, skipping reblog action`);
                } else {
                    elizaLogger.error(`Failed to reblog post ${post.id}: ${error.message}`);
                }
            }
        }

        // If it's a group post, skip quote and reply actions
        if (isGroupPost) {
            elizaLogger.debug(`Post ${post.id} is in a group, skipping quote and reply actions`);
            return executedActions;
        }

        // Handle quote action
        if (truthSocialResponse.quote) {
            elizaLogger.debug(`Generating quote for post ${post.id}`);
            try {
                const quoteContent = await this.generateContent(post, username, 'QUOTE', imageDescriptions, roomId);
                if (quoteContent) {
                    await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                        status: quoteContent,
                        quote_id: post.id
                    });
                    elizaLogger.log(`✓ Posted quote for ${post.id}`);
                    executedActions.push('QUOTE');
                }
            } catch (error) {
                if (this.isGroupError(error)) {
                    elizaLogger.debug(`Post ${post.id} is in a group, skipping quote action`);
                } else {
                    elizaLogger.error(`Failed to post quote for ${post.id}: ${error.message}`);
                }
            }
        }

        // Handle reply action
        if (truthSocialResponse.reply) {
            elizaLogger.debug(`Generating reply for post ${post.id}`);
            try {
                const replyContent = await this.generateContent(post, username, 'REPLY', imageDescriptions, roomId);
                if (replyContent) {
                    await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                        status: replyContent,
                        in_reply_to_id: post.id
                    });
                    elizaLogger.log(`✓ Posted reply to ${post.id}`);
                    executedActions.push('REPLY');
                }
            } catch (error) {
                if (this.isGroupError(error)) {
                    elizaLogger.debug(`Post ${post.id} is in a group, skipping reply action`);
                } else {
                    elizaLogger.error(`Failed to post reply to ${post.id}: ${error.message}`);
                }
            }
        }

        return executedActions;
    }

    protected async checkItems() {
        if (this.isProcessing) {
            elizaLogger.debug("Already processing posts, skipping");
            return;
        }

        const targetUsers = this.config.TRUTHSOCIAL_TARGET_USERS;
        if (!targetUsers || targetUsers.length === 0) {
            elizaLogger.debug("No target users configured, skipping post monitoring");
            return;
        }

        try {
            this.isProcessing = true;

            for (const username of targetUsers) {
                try {
                    const lastKnownPostId = this.lastCheckedPosts.get(username);
                    const posts = await this.getUserTimeline(username, {
                        limit: 20,
                        exclude_replies: true
                    });

                    if (posts.length === 0) continue;

                    // If this is the first time we're seeing this user
                    const isFirstFetch = !lastKnownPostId;
                    if (isFirstFetch) {
                        elizaLogger.debug(`First time fetching posts for ${username}, storing initial posts in memory without taking actions`);
                        // Store all posts in memory without taking actions
                        for (const post of posts) {
                            await this.processPost(post, username, false);
                        }
                    } else {
                        // For subsequent fetches, only take actions on new posts
                        for (const post of posts) {
                            const isNewPost = post.id > lastKnownPostId;
                            await this.processPost(post, username, isNewPost);
                        }
                    }

                    // Update last checked post ID after processing
                    this.lastCheckedPosts.set(username, posts[0].id);

                } catch (error) {
                    elizaLogger.error(`Error monitoring ${username}: ${error.message}`);
                }
            }
        } catch (error) {
            elizaLogger.error("Error checking posts:", error);
        } finally {
            this.isProcessing = false;
        }
    }

    public async cleanup() {
        await super.cleanup();
        this.lastCheckedPosts.clear();
        this.actedOnPosts.clear();
    }

    private async processPost(post: TruthSocialPost, username: string, shouldTakeActions: boolean = true) {
        try {
            // Check if we already have this post in memory
            const postMemoryId = stringToUuid(post.id + "-" + this.runtime.agentId);
            const existingMemory = await this.runtime.messageManager.getMemoryById(postMemoryId);

            if (existingMemory) {
                elizaLogger.debug(`Post ${post.id} already exists in memory, skipping`);
                this.processedItems.add(post.id);
                return;
            }

            elizaLogger.log(`Processing new post ${post.id} from ${username}`);

            let executedActions: string[] = [];
            let imageDescriptions: any[] = [];

            // Only take actions if this is a new post and we haven't acted on it before
            if (shouldTakeActions && !this.actedOnPosts.has(post.id)) {
                // Process images if enabled
                if (this.config.TRUTHSOCIAL_PROCESS_IMAGES) {
                    await this.processMediaAttachments(post.media_attachments, imageDescriptions, post.id);
                }

                // Assess if we should take action on this post
                const roomId = stringToUuid(`truthsocial_${username}`);
                const postContent = `ID: ${post.id}\nFrom: ${username}\nText: ${post.content}`;
                const state = await this.runtime.composeState(
                    {
                        userId: this.runtime.agentId,
                        roomId,
                        agentId: this.runtime.agentId,
                        content: {
                            text: postContent,
                            action: "PROCESS_POST"
                        },
                    },
                    {
                        currentPost: postContent,
                        imageDescriptions: imageDescriptions.length > 0
                            ? `\nImages in Post:\n${imageDescriptions.map((desc, i) =>
                                `Image ${i + 1}: ${desc.description}`).join("\n\n")}`
                            : ""
                    }
                );

                const actionContext = composeContext({
                    state,
                    template: truthSocialActionTemplate,
                });

                const actionResponse = await generateTweetActions({
                    runtime: this.runtime,
                    context: actionContext,
                    modelClass: ModelClass.SMALL,
                });

                elizaLogger.debug(`Action response: ${JSON.stringify(actionResponse)}`);

                // Handle all actions using base class methods
                executedActions = await this.handlePostActions(
                    post,
                    username,
                    actionResponse,
                    imageDescriptions,
                    roomId
                );

                // Mark that we've taken actions on this post
                if (executedActions.length > 0) {
                    this.actedOnPosts.add(post.id);
                }
            }

            // Store in memory using base class method
            await this.storeInMemory({
                id: post.id,
                roomId: stringToUuid(`truthsocial_${username}`),
                content: post.content,
                metadata: {
                    id: post.id,
                    created_at: post.created_at,
                    username: username,
                    url: post.url,
                    reblogs_count: post.reblogs_count,
                    favourites_count: post.favourites_count,
                    raw_content: post.content,
                    media_attachments: post.media_attachments,
                    image_descriptions: imageDescriptions?.length > 0 ? imageDescriptions : undefined,
                    executedActions
                },
                source: 'truthsocial',
                createdAt: post.created_at
            });

        } catch (error) {
            elizaLogger.error(`Error processing post ${post.id}: ${error.message}`);
        }
    }
}