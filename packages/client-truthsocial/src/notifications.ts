import { elizaLogger, stringToUuid,getEmbeddingZeroVector,composeContext, generateTweetActions, ModelClass, UUID, IAgentRuntime } from "@elizaos/core";
import { TruthSocialConfig } from "./environment";
import { TruthSocialPost, TruthSocialAccount, NotificationType, TruthSocialActionResponse } from "./types";
import { processContent } from "./utils/content";
import { BaseMonitorClient } from "./base-monitor";

// Types for Truth Social notifications
export interface TruthSocialNotification {
    id: string;
    type: NotificationType;
    created_at: string;
    status?: TruthSocialPost;
    account: TruthSocialAccount;
}

import { truthSocialMessageTemplate, truthSocialActionTemplate } from "./templates";

export class NotificationsClient extends BaseMonitorClient {
    private lastCheckedNotificationId?: string;
    protected readonly clientType = 'notifications' as const;

    constructor(runtime: IAgentRuntime, config: TruthSocialConfig) {
        super(runtime, config);
    }

    protected async checkItems() {
        if (this.isProcessing) {
            elizaLogger.debug("Already processing notifications, skipping");
            return;
        }

        try {
            this.isProcessing = true;

            const notifications = await this.fetchNotifications();
            if (!notifications || notifications.length === 0) return;

            // Process notifications in chronological order
            for (const notification of notifications.reverse()) {
                try {
                    // Skip if already processed
                    if (this.processedItems.has(notification.id)) {
                        elizaLogger.debug(`Skipping notification ${notification.id} - already in processed set`);
                        continue;
                    }

                    // Check if we already have this notification in memory
                    const notificationMemoryId = stringToUuid(notification.id + "-" + this.runtime.agentId);
                    const existingMemory = await this.runtime.messageManager.getMemoryById(notificationMemoryId);

                    if (existingMemory) {
                        elizaLogger.debug(`Notification ${notification.id} already exists in memory, skipping`);
                        this.processedItems.add(notification.id);
                        continue;
                    }

                    elizaLogger.log(`Processing new notification ${notification.id}`);
                    await this.handleNotification(notification);

                    // Update last checked ID and mark as processed
                    this.lastCheckedNotificationId = notification.id;
                    this.processedItems.add(notification.id);

                } catch (error) {
                    elizaLogger.error(`Error processing notification ${notification.id}:`, error);
                }
            }

        } catch (error) {
            elizaLogger.error("Error checking notifications:", error);
        } finally {
            this.isProcessing = false;
        }
    }

    private async fetchNotifications(): Promise<TruthSocialNotification[]> {
        try {
            const params = {
                types: [
                    'follow',
                    'mention',
                    'reblog',
                    'favourite',
                    'group_favourite',
                    'group_reblog',
                    'group_mention',
                    'poll',
                    'poll_owned',
                    'status'
                ] as NotificationType[]
            };

            const response = await this.makeAuthenticatedRequest('/v1/notifications', 'GET', params);
            return response || [];
        } catch (error) {
            elizaLogger.error("Error fetching notifications:", error);
            return [];
        }
    }

    private async formatNotificationForLLM(notification: TruthSocialNotification): Promise<string> {
        let content = `Type: ${notification.type}\n`;
        content += `From: ${notification.account.display_name} (@${notification.account.username})\n`;

        if (notification.status) {
            const { processedContent, isSummarized } = await processContent(notification.status.content, this.runtime);
            content += `Content: ${isSummarized ? "[Summarized] " : ""}${processedContent}\n`;
            if (notification.status.media_attachments?.length) {
                content += `Media: ${notification.status.media_attachments.length} attachments\n`;
            }
        }

        return content;
    }

    private async handleNotification(notification: TruthSocialNotification) {
        const roomId = stringToUuid(`truthsocial_notification_${notification.id}`);

        // Process notification content for LLM
        const notificationContent = await this.formatNotificationForLLM(notification);

        // Get LLM decision on how to handle notification
        const state = await this.runtime.composeState(
            {
                userId: this.runtime.agentId,
                roomId,
                agentId: this.runtime.agentId,
                content: {
                    text: notificationContent || `Notification ${notification.id} from ${notification.account.username}`,
                    action: "PROCESS_NOTIFICATION"
                },
            },
            {
                notificationContent: notificationContent || `Notification ${notification.id} from ${notification.account.username}`
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
        }) as TruthSocialActionResponse & { follow_back?: boolean };

        // Execute actions based on LLM decision
        const executedActions = await this.executeNotificationActions(notification, actionResponse, roomId);

        // Store notification in memory
        await this.storeNotificationMemory(notification, executedActions, roomId);
    }

    private async executeNotificationActions(
        notification: TruthSocialNotification,
        actionResponse: TruthSocialActionResponse & { follow_back?: boolean },
        roomId: UUID
    ): Promise<string[]> {
        const executedActions: string[] = [];

        try {
            // Handle follow-back for follow notifications
            if (notification.type === 'follow' && actionResponse.follow_back) {
                elizaLogger.log(`Following back user ${notification.account.id}`);
                try {
                    await this.makeAuthenticatedRequest(`/v1/accounts/${notification.account.id}/follow`, 'POST');
                    elizaLogger.log(`Successfully followed back user ${notification.account.id}`);
                    executedActions.push('FOLLOW_BACK');
                } catch (error) {
                    elizaLogger.error(`Failed to follow back user ${notification.account.id}: ${error.message}`);
                }
            }

            // Handle post-related actions using base class methods
            if (notification.status) {
                const postActions = await this.handlePostActions(
                    notification.status,
                    notification.account.username,
                    actionResponse,
                    [], // No image descriptions for notifications
                    roomId
                );
                executedActions.push(...postActions);
            }
        } catch (error) {
            elizaLogger.error(`Error executing actions for notification ${notification.id}:`, error);
        }

        return executedActions;
    }

    private async storeNotificationMemory(
        notification: TruthSocialNotification,
        executedActions: string[],
        roomId: UUID
    ) {
        await this.storeInMemory({
            id: notification.id,
            roomId,
            content: notification.status?.content || '',
            metadata: {
                id: notification.id,
                type: notification.type,
                created_at: notification.created_at,
                account: notification.account,
                status: notification.status,
                executedActions
            },
            source: 'truthsocial_notification',
            createdAt: notification.created_at
        });
    }

    public async cleanup() {
        await super.cleanup();
        this.lastCheckedNotificationId = undefined;
    }
}