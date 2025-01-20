import {
    elizaLogger,
    composeContext,
    generateText,
    ModelClass,
    stringToUuid,
    UUID,
    getEmbeddingZeroVector,
    IImageDescriptionService,
    ServiceType
} from "@elizaos/core";
import { ClientBase } from "./base";
import { TruthSocialConfig } from "./environment";

const truthSocialPostTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# Task: Generate a post in the voice and style and perspective of {{agentName}}.
Write a post that is {{adjective}} about {{topic}} (without mentioning {{topic}} directly).
Do not add commentary or acknowledge this request, just write the post.
Your response should be 1, 2, or 3 sentences (choose the length at random).
Your response should not contain any questions. Brief, concise statements only.
The total character count MUST be less than {{maxPostLength}}. No emojis.
Use \\n\\n (double spaces) between statements if there are multiple statements in your response.`;

export interface TruthSocialPostOptions {
    status: string;
    in_reply_to_id?: string;
    quote_id?: string;
    media_ids?: string[];
    sensitive?: boolean;
    spoiler_text?: string;
    visibility?: 'public' | 'unlisted' | 'private' | 'direct';
}

export class PostClient extends ClientBase {
    private isPosting = false;
    private postQueue: TruthSocialPostOptions[] = [];
    private postInterval?: NodeJS.Timeout;

    async startPostingLoop() {
        if (this.isPosting) {
            elizaLogger.warn("Posting loop already running");
            return;
        }

        this.isPosting = true;

        // Handle immediate posting first if configured
        if (this.config.POST_IMMEDIATELY) {
            elizaLogger.info("POST_IMMEDIATELY is true, generating and posting immediately...");
            try {
                await this.generateAndQueuePost();
                // Force immediate processing of the queued post
                const post = this.postQueue[0];
                if (post) {
                    elizaLogger.info("Processing immediate post...");
                    await this.createPost(post);
                    this.postQueue.shift(); // Remove the processed post
                    elizaLogger.info("Successfully posted immediately to Truth Social");
                }
            } catch (error) {
                elizaLogger.error("Failed to post immediately:", error);
            }
        }

        // Set up scheduled posting if intervals are configured
        const minInterval = (this.config.POST_INTERVAL_MIN || 90) * 60 * 1000;
        const maxInterval = (this.config.POST_INTERVAL_MAX || 180) * 60 * 1000;

        if (minInterval > 0 && maxInterval > 0) {
            const interval = this.getRandomInterval(minInterval, maxInterval);
            const nextPostTime = new Date(Date.now() + interval);
            elizaLogger.info(`Next scheduled post will be at: ${nextPostTime.toLocaleString()}`);

            this.postInterval = setInterval(async () => {
                elizaLogger.info("Post interval triggered, generating new post...");
                await this.generateAndQueuePost();
                await this.processNextPost();

                // Log next scheduled post time
                const nextInterval = this.getRandomInterval(minInterval, maxInterval);
                const nextTime = new Date(Date.now() + nextInterval);
                elizaLogger.info(`Next post scheduled for: ${nextTime.toLocaleString()}`);
            }, interval);

            elizaLogger.info("Truth Social posting loop started");
        } else {
            elizaLogger.info("No posting intervals configured, only immediate posts will be made");
        }
    }

    private async generateAndQueuePost() {
        try {
            elizaLogger.info("Starting post generation process...");
            const roomId: UUID = stringToUuid("truthsocial_generate_room-" + this.config.TRUTHSOCIAL_USERNAME);

            // Ensure user exists
            await this.runtime.ensureUserExists(
                this.runtime.agentId,
                this.config.TRUTHSOCIAL_USERNAME,
                this.runtime.character.name,
                "truthsocial"
            );

            const topics = this.runtime.character.topics.join(", ");
            elizaLogger.debug("Available topics:", topics);

            // Log character info being used
            elizaLogger.debug("Character info:", {
                name: this.runtime.character.name,
                bio: this.runtime.character.bio,
                lore: this.runtime.character.lore,
                style: this.runtime.character.style
            });

            const state = await this.runtime.composeState({
                userId: this.runtime.agentId,
                roomId,
                agentId: this.runtime.agentId,
                content: {
                    text: topics || "",
                    action: "POST"
                }
            }, {
                maxPostLength: this.config.MAX_POST_LENGTH
            });

            elizaLogger.debug("Composed state:", state);

            // Log which template we're using
            const template = truthSocialPostTemplate;


            const context = composeContext({
                state,
                template
            });

            elizaLogger.debug("Generated prompt for LLM:\n" + context);

            elizaLogger.info("Sending request to LLM...");
            const post = await generateText({
                runtime: this.runtime,
                context,
                modelClass: ModelClass.SMALL
            });

            elizaLogger.info("Raw LLM response:", post);

            // Clean up the generated post
            const cleanedPost = this.cleanGeneratedPost(post);
            elizaLogger.info("Cleaned post to be queued:", cleanedPost);

            await this.queuePost({
                status: cleanedPost,
                visibility: 'public'
            });
            elizaLogger.info(`Current queue length: ${this.postQueue.length}`);
        } catch (error) {
            elizaLogger.error("Failed to generate post:", error);
        }
    }

    private cleanGeneratedPost(post: string): string {
        // Try parsing as JSON first
        try {
            const parsed = JSON.parse(post);
            if (parsed.text) {
                return this.formatPost(parsed.text);
            }
        } catch {
            // Not JSON, clean the raw text
        }

        return this.formatPost(post);
    }

    private formatPost(text: string): string {
        return text
            .replace(/^\s*{?\s*"text":\s*"|"\s*}?\s*$/g, "") // Remove JSON-like wrapper
            .replace(/^['"](.*)['"]$/g, "$1") // Remove quotes
            .replace(/\\"/g, '"') // Unescape quotes
            .replace(/\\n/g, "\n\n") // Ensure double spaces between statements
            .trim();
    }

    async stopPostingLoop() {
        this.isPosting = false;
        if (this.postInterval) {
            clearInterval(this.postInterval);
            this.postInterval = undefined;
        }
        elizaLogger.info("Truth Social posting loop stopped");
    }

    async queuePost(post: TruthSocialPostOptions) {
        this.postQueue.push(post);
        elizaLogger.info("Post queued for Truth Social");
    }

    private async processNextPost() {
        if (!this.isPosting || this.postQueue.length === 0) {
            elizaLogger.debug("No posts to process (queue empty or posting disabled)");
            return;
        }

        const post = this.postQueue.shift();
        if (!post) return;

        elizaLogger.info("Processing post from queue:", post.status);
        try {
            await this.createPost(post);
            elizaLogger.info("Successfully posted to Truth Social");
            elizaLogger.info(`Remaining posts in queue: ${this.postQueue.length}`);
        } catch (error) {
            elizaLogger.error("Failed to post to Truth Social:", error);
            elizaLogger.info("Requeueing failed post");
            this.postQueue.unshift(post);
        }
    }

    private async createPost(options: TruthSocialPostOptions) {
        elizaLogger.debug("Attempting to create post with options:", options);
        try {
            const response = await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                status: options.status,
                in_reply_to_id: options.in_reply_to_id,
                quote_id: options.quote_id,
                media_ids: options.media_ids,
                sensitive: options.sensitive,
                spoiler_text: options.spoiler_text,
                visibility: options.visibility || 'public'
            });


            if (response.media_attachments) {
                elizaLogger.log('Media attachments in response:', JSON.stringify(response.media_attachments, null, 2));
            }

            // Process images if present
            const imageDescriptions = [];
            if (response.media_attachments && response.media_attachments.length > 0) {
                elizaLogger.log('Processing images in post');
                for (const media of response.media_attachments) {
                    if (media.type === 'image') {
                        try {
                            const description = await this.runtime
                                .getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION)
                                .describeImage(media.url);
                            imageDescriptions.push({
                                mediaId: media.id,
                                url: media.url,
                                description
                            });
                        } catch (error) {
                            elizaLogger.error(`Error describing image: ${error.message}`);
                        }
                    }
                }
            }

            // Save post to memory
            const roomId = stringToUuid(`truthsocial_${this.config.TRUTHSOCIAL_USERNAME}`);

            // Ensure room exists and agent is participant
            await this.runtime.ensureRoomExists(roomId);
            await this.runtime.ensureParticipantInRoom(this.runtime.agentId, roomId);

            // Create memory for the post
            await this.runtime.messageManager.createMemory({
                id: stringToUuid(response.id + "-" + this.runtime.agentId),
                userId: this.runtime.agentId,
                agentId: this.runtime.agentId,
                content: {
                    text: options.status,
                    source: 'truthsocial',
                    url: response.url,
                    metadata: {
                        id: response.id,
                        created_at: response.created_at,
                        username: this.config.TRUTHSOCIAL_USERNAME,
                        reblogs_count: response.reblogs_count,
                        favourites_count: response.favourites_count,
                        raw_content: response.content,
                        media_attachments: response.media_attachments,
                        image_descriptions: imageDescriptions.length > 0 ? imageDescriptions : undefined
                    }
                },
                roomId,
                embedding: getEmbeddingZeroVector(),
                createdAt: new Date(response.created_at).getTime()
            });

            elizaLogger.log(`Stored post ${response.id} in memory`);
            return response;
        } catch (error) {
            elizaLogger.error("Post creation failed:", error);
            throw error;
        }
    }

    private getRandomInterval(min: number, max: number): number {
        return Math.floor(Math.random() * (max - min + 1) + min);
    }
}