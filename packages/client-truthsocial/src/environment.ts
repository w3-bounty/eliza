import { z } from "zod";
import { IAgentRuntime } from "@elizaos/core";

// Constants from Truth Social
export const BASE_URL = "https://truthsocial.com";
export const API_BASE_URL = "https://truthsocial.com/api";
// Oauth client credentials, from https://truthsocial.com/packs/js/application-d77ef3e9148ad1d0624c.js
export const CLIENT_ID = "9X1Fdd-pxNsAgEDNi_SfhJWi8T-vLuV2WVzKIbkTCw4";
export const CLIENT_SECRET = "ozF8jzI4968oTKFkEnsBC-UbLPCdrSv0MkXGQu2o_-M";
export const DEFAULT_MAX_POST_LENGTH = 3000;

export const TruthSocialConfigSchema = z.object({
    TRUTHSOCIAL_USERNAME: z.string(),
    TRUTHSOCIAL_PASSWORD: z.string(),
    TRUTHSOCIAL_RETRY_LIMIT: z.number().default(3),
    POST_INTERVAL_MIN: z.number().default(90),
    POST_INTERVAL_MAX: z.number().default(180),
    POST_IMMEDIATELY: z.boolean().default(false),
    MAX_POST_LENGTH: z.number().default(DEFAULT_MAX_POST_LENGTH),
    TRUTHSOCIAL_TARGET_USERS: z.string().optional().transform(val =>
        val ? val.split(',').map(u => u.trim()) : []
    ),
    TRUTHSOCIAL_PROCESS_IMAGES: z.boolean().default(false),
    TRUTHSOCIAL_COOKIES: z.string().optional(),
    TRUTHSOCIAL_AUTH_TOKEN: z.string().optional(),
    TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL: z.number().default(15),
    TRUTHSOCIAL_SEARCH_CHECK_INTERVAL: z.number().default(15),
});

export type TruthSocialConfig = z.infer<typeof TruthSocialConfigSchema>;

export async function validateTruthSocialConfig(
    runtime: IAgentRuntime
): Promise<TruthSocialConfig> {
    try {
        const config = {
            TRUTHSOCIAL_USERNAME: runtime.getSetting("TRUTHSOCIAL_USERNAME") ||
                                process.env.TRUTHSOCIAL_USERNAME,
            TRUTHSOCIAL_PASSWORD: runtime.getSetting("TRUTHSOCIAL_PASSWORD") ||
                                process.env.TRUTHSOCIAL_PASSWORD,
            TRUTHSOCIAL_RETRY_LIMIT: parseInt(
                runtime.getSetting("TRUTHSOCIAL_RETRY_LIMIT") ||
                process.env.TRUTHSOCIAL_RETRY_LIMIT ||
                "3"
            ),
            POST_INTERVAL_MIN: parseInt(
                runtime.getSetting("TRUTHSOCIAL_POST_INTERVAL_MIN") ||
                process.env.TRUTHSOCIAL_POST_INTERVAL_MIN ||
                "90"
            ),
            POST_INTERVAL_MAX: parseInt(
                runtime.getSetting("TRUTHSOCIAL_POST_INTERVAL_MAX") ||
                process.env.TRUTHSOCIAL_POST_INTERVAL_MAX ||
                "180"
            ),
            POST_IMMEDIATELY: runtime.getSetting("TRUTHSOCIAL_POST_IMMEDIATELY") === "true" ||
                                process.env.TRUTHSOCIAL_POST_IMMEDIATELY === "true",
            MAX_POST_LENGTH: parseInt(
                runtime.getSetting("TRUTHSOCIAL_MAX_POST_LENGTH") ||
                process.env.TRUTHSOCIAL_MAX_POST_LENGTH ||
                DEFAULT_MAX_POST_LENGTH.toString()
            ),
            TRUTHSOCIAL_TARGET_USERS: runtime.getSetting("TRUTHSOCIAL_TARGET_USERS") ||
                                    process.env.TRUTHSOCIAL_TARGET_USERS || [],
            TRUTHSOCIAL_PROCESS_IMAGES: runtime.getSetting("TRUTHSOCIAL_PROCESS_IMAGES") === "true" ||
                                        process.env.TRUTHSOCIAL_PROCESS_IMAGES === "true",
            TRUTHSOCIAL_COOKIES: runtime.getSetting("TRUTHSOCIAL_COOKIES") ||
                                process.env.TRUTHSOCIAL_COOKIES,
            TRUTHSOCIAL_AUTH_TOKEN: runtime.getSetting("TRUTHSOCIAL_AUTH_TOKEN") ||
                                process.env.TRUTHSOCIAL_AUTH_TOKEN,
            TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL: parseInt(
                runtime.getSetting("TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL") ||
                process.env.TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL ||
                "15"
            ),
            TRUTHSOCIAL_SEARCH_CHECK_INTERVAL: parseInt(
                runtime.getSetting("TRUTHSOCIAL_SEARCH_CHECK_INTERVAL") ||
                process.env.TRUTHSOCIAL_SEARCH_CHECK_INTERVAL ||
                "15"
            )
        };

        return TruthSocialConfigSchema.parse(config);
    } catch (error) {
        if (error instanceof z.ZodError) {
            const errorMessages = error.errors
                .map((err) => `${err.path.join(".")}: ${err.message}`)
                .join("\n");
            throw new Error(
                `Truth Social configuration validation failed:\n${errorMessages}`
            );
        }
        throw error;
    }
}