import { Client, elizaLogger, IAgentRuntime, Clients } from "@elizaos/core";
import { validateTruthSocialConfig, TruthSocialConfig } from "./environment";
import { PostClient } from "./post";
import { SearchClient } from "./search";
import { NotificationsClient } from "./notifications";
import { ClientBase } from "./base";

// Combine Search, Post and Notifications capabilities
export class TruthSocialClient extends PostClient {
    private searchClient: SearchClient;
    private notificationsClient: NotificationsClient;

    constructor(runtime: IAgentRuntime, config: TruthSocialConfig) {
        super(runtime, config);
        this.searchClient = new SearchClient(runtime, config);
        this.notificationsClient = new NotificationsClient(runtime, config);
    }

    async init() {
        elizaLogger.log("Initializing main Truth Social client");
        await super.init();  // This will handle the login and token setup

        // No need to initialize search client separately since it shares the static auth token
        elizaLogger.log("Search client ready (using shared auth token)");
        elizaLogger.log("Notifications client ready (using shared auth token)");
    }

    // Expose search methods
    async searchUsers(query: string, limit?: number) {
        return this.searchClient.searchUsers(query, limit);
    }

    async getUserTimeline(username: string, options = {}) {
        return this.searchClient.getUserTimeline(username, options);
    }

    async searchPosts(query: string, limit?: number) {
        return this.searchClient.searchPosts(query, limit);
    }

    public async start() {
        await this.searchClient.start();
        await this.notificationsClient.start();
    }

    public async stop() {
        await this.searchClient.stop();
        await this.notificationsClient.stop();
    }

    async cleanup() {
        await this.searchClient.cleanup();
        await this.notificationsClient.cleanup();
        await ClientBase.cleanup();
    }
}

export const TruthSocialClientInterface: Client = {
    async start(runtime: IAgentRuntime) {
        const config = await validateTruthSocialConfig(runtime);
        elizaLogger.log("Truth Social client starting");

        const client = new TruthSocialClient(runtime, config);
        await client.init();  // This will handle all initialization including auth
        await client.startPostingLoop();

        // Start monitoring if target users are configured
        if (config.TRUTHSOCIAL_TARGET_USERS?.length > 0) {
            elizaLogger.log(`Starting monitoring for users: ${config.TRUTHSOCIAL_TARGET_USERS.join(', ')}`);
            await client.start();
        }

        return client;
    },

    async stop(runtime: IAgentRuntime) {
        const client = runtime.clients?.[Clients.TRUTHSOCIAL] as TruthSocialClient;
        if (client) {
            await client.stopPostingLoop();
            await client.stop();
            await client.cleanup();
            elizaLogger.info("Truth Social client stopped");
        }
    },
};

export default TruthSocialClientInterface;

export * from './base';
export * from './post';
export * from './search';
export * from './environment';
export * from './notifications';