import {
    IAgentRuntime,
    elizaLogger,
    IImageDescriptionService,
    ServiceType,
    UUID,
    composeContext,
    generateText,
    ModelClass
} from "@elizaos/core";
import { TruthSocialConfig, BASE_URL, CLIENT_ID, CLIENT_SECRET } from "./environment";
import { TruthSocialPost, TruthSocialActionResponse } from "./types";
import { truthSocialMessageTemplate } from "./templates";
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import AdblockerPlugin from 'puppeteer-extra-plugin-adblocker';
import { access } from 'fs/promises';
import { constants } from 'fs';
import { EncryptionService } from "./utils/encryption";

puppeteer.use(StealthPlugin());
puppeteer.use(AdblockerPlugin({ blockTrackers: true }));

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API_BASE_URL = "https://truthsocial.com/api";

interface LoginResponse {
    cookies: any[];
    accessToken: string;
}

export class ClientBase {
    protected runtime: IAgentRuntime;
    protected config: TruthSocialConfig;
    protected imageDescriptionService: IImageDescriptionService;
    private static authToken: string | null = null;  // Make authToken static
    static _truthSocialClients: { [accountIdentifier: string]: any } = {};
    private static browser: any;
    private static page: any;
    private browser: any;  // Instance reference to static browser
    private page: any;     // Instance reference to static page
    private encryptionService: EncryptionService;

    constructor(runtime: IAgentRuntime, config: TruthSocialConfig) {
        this.runtime = runtime;
        this.config = config;
        this.imageDescriptionService = this.runtime.getService<IImageDescriptionService>(ServiceType.IMAGE_DESCRIPTION);
        this.encryptionService = EncryptionService.getInstance();

        // Log basic client initialization
        elizaLogger.log('Truth Social Client initialized:', {
            username: config.TRUTHSOCIAL_USERNAME,
            imageProvider: runtime.character?.imageModelProvider || 'openai'
        });

        // Initialize instance references
        this.browser = ClientBase.browser;
        this.page = ClientBase.page;
    }

    // Add getter/setter for authToken to use static value
    protected get authToken(): string | null {
        return ClientBase.authToken;
    }

    protected set authToken(value: string | null) {
        ClientBase.authToken = value;
    }

    async init() {
        elizaLogger.log("Initializing Truth Social client");

        // Initialize encryption service first
        await this.encryptionService.initialize();

        let retries = this.config.TRUTHSOCIAL_RETRY_LIMIT;

        const username = this.config.TRUTHSOCIAL_USERNAME;
        if (ClientBase._truthSocialClients[username]) {
            elizaLogger.info("Using existing Truth Social client");
            return;
        }

        // Try to use cached token first
        const cachedToken = await this.getCachedToken(username);
        if (cachedToken) {
            elizaLogger.info("Using cached token");
            this.authToken = cachedToken;
            if (await this.validateSession()) {
                ClientBase._truthSocialClients[username] = this;
                return;
            }
        }

        // Full login flow with retries
        while (retries > 0) {
            try {
                await this.login();
                if (this.authToken) {
                    elizaLogger.info("Successfully logged in to Truth Social");
                    ClientBase._truthSocialClients[username] = this;
                    return;
                }
            } catch (error) {
                elizaLogger.error(`Login attempt failed: ${error.message}`);
                retries--;
                if (retries === 0) {
                    throw new Error("Truth Social login failed after maximum retries");
                }
                // Increase delay between retries exponentially
                const delay = Math.pow(2, this.config.TRUTHSOCIAL_RETRY_LIMIT - retries) * 1000;
                elizaLogger.info(`Waiting ${delay/1000} seconds before next retry...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    private async validateSession(): Promise<boolean> {
        if (!this.authToken) return false;

        try {
            await this.setupBrowser();
            const response = await this.page.evaluate(async (authToken) => {
                const resp = await fetch(`${API_BASE_URL}/v1/accounts/verify_credentials`, {
                    method: 'GET',
                    headers: {
                        'content-type': 'application/json',
                        'Authorization': `Bearer ${authToken}`
                    },
                    credentials: 'include'
                });
                return { ok: resp.ok };
            }, this.authToken);

            return response.ok;
        } catch (error) {
            elizaLogger.error("Session validation error:", error);
            return false;
        }
    }

    private async setupBrowser() {
        if (!ClientBase.browser) {
            elizaLogger.info("Setting up new browser session...");
            try {
                // Try to find Chrome in common locations
                const possiblePaths = [
                    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                    '/usr/bin/google-chrome',
                    '/usr/bin/google-chrome-stable'
                ];

                let chromePath;
                for (const path of possiblePaths) {
                    try {
                        await access(path, constants.F_OK);
                        chromePath = path;
                        break;
                    } catch {
                        continue;
                    }
                }

                ClientBase.browser = await puppeteer.launch({
                    headless: 'new',
                    executablePath: chromePath,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--window-size=1920x1080',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process'
                    ],
                    defaultViewport: null,
                    timeout: 30000,
                    ignoreHTTPSErrors: true,
                });

                ClientBase.page = await ClientBase.browser.newPage();

                // Basic error handling
                ClientBase.page.on('error', err => {
                    elizaLogger.error('Page error:', err.message);
                });

                // Set viewport and headers
                await ClientBase.page.setViewport({ width: 1920, height: 1080 });
                await ClientBase.page.setExtraHTTPHeaders({
                    'accept': 'application/json, text/plain, */*',
                    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
                    'content-type': 'application/json',
                    'user-agent': USER_AGENT,
                    'priority': 'u=1, i',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-origin'
                });

                // Visit the site first to get cookies
                await ClientBase.page.goto('https://truthsocial.com', {
                    waitUntil: 'networkidle0',
                    timeout: 30000
                });

                // Update both static and instance references
                this.browser = ClientBase.browser;
                this.page = ClientBase.page;
            } catch (error) {
                elizaLogger.error("Browser setup error:", error);
                throw error;
            }
        } else {
            // Use existing browser session
            this.browser = ClientBase.browser;
            this.page = ClientBase.page;
        }
        return true;
    }

    private async login(): Promise<LoginResponse> {
        try {
            elizaLogger.debug("Starting login process...");
            await this.setupBrowser();

            // Try to use cookies and auth token from environment variables first
            if (this.config.TRUTHSOCIAL_COOKIES && this.config.TRUTHSOCIAL_AUTH_TOKEN) {
                try {
                    // Handle potential double-encoded JSON
                    let cookiesArray;
                    try {
                        cookiesArray = JSON.parse(this.config.TRUTHSOCIAL_COOKIES);
                    } catch (e) {
                        // If first parse fails, try unescaping the string first
                        const unescaped = this.config.TRUTHSOCIAL_COOKIES.replace(/\\"/g, '"');
                        cookiesArray = JSON.parse(unescaped);
                    }

                    await this.setCookies(cookiesArray);
                    ClientBase.authToken = this.config.TRUTHSOCIAL_AUTH_TOKEN;
                    elizaLogger.debug("Using cookies and auth token from environment variables");

                    // Visit the site first to set up cookies properly
                    await this.page.goto('https://truthsocial.com', {
                        waitUntil: 'networkidle0',
                        timeout: 30000
                    });

                    // Verify if the session is valid
                    const isValid = await this.validateSession();
                    if (isValid) {
                        elizaLogger.debug("Session is valid, skipping login");
                        return {
                            cookies: await this.getCookies(),
                            accessToken: this.authToken
                        };
                    }
                    elizaLogger.debug("Session is invalid, proceeding with login");
                } catch (error) {
                    elizaLogger.error("Failed to use environment credentials:", error);
                }
            }

            // Try to use cached token
            const cachedToken = await this.getCachedToken(this.config.TRUTHSOCIAL_USERNAME);
            if (cachedToken) {
                ClientBase.authToken = cachedToken;
                const isValid = await this.validateSession();
                if (isValid) {
                    elizaLogger.debug("Using cached token");
                    return {
                        cookies: await this.getCookies(),
                        accessToken: this.authToken
                    };
                }
                elizaLogger.debug("Cached token invalid, proceeding with login");
            }

            elizaLogger.debug("Making login request...");
            const loginResponse = await this.page.evaluate(async ({ url, payload }) => {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        'accept': 'application/json, text/plain, */*',
                        'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
                        'priority': 'u=1, i',
                        'sec-fetch-dest': 'empty',
                        'sec-fetch-mode': 'cors',
                        'sec-fetch-site': 'same-origin'
                    },
                    body: JSON.stringify(payload),
                    credentials: 'include'
                });

                const text = await resp.text();
                return {
                    ok: resp.ok,
                    status: resp.status,
                    data: text
                };
            }, {
                url: `${BASE_URL}/oauth/token`,
                payload: {
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    redirect_uri: "urn:ietf:wg:oauth:2.0:oob",
                    grant_type: "password",
                    scope: "read write follow push",
                    username: this.config.TRUTHSOCIAL_USERNAME,
                    password: this.config.TRUTHSOCIAL_PASSWORD
                }
            });

            if (!loginResponse.ok) {
                elizaLogger.error(`Login failed: ${loginResponse.status} ${loginResponse.data}`);
                throw new Error(`Login failed: ${loginResponse.status}`);
            }

            try {
                const responseData = JSON.parse(loginResponse.data);
                ClientBase.authToken = responseData.access_token;

                // Cache the new token
                await this.cacheToken(this.config.TRUTHSOCIAL_USERNAME, responseData.access_token);

                // Get and format cookies for environment variable
                const cookies = await this.page.cookies();
                const formattedCookies = this.formatCookiesForEnv(cookies);
                elizaLogger.debug("Set these as your environment variables:");
                elizaLogger.debug(`TRUTHSOCIAL_COOKIES='${JSON.stringify(formattedCookies)}'`);
                elizaLogger.debug(`TRUTHSOCIAL_AUTH_TOKEN='${responseData.access_token}'`);

            } catch (error) {
                elizaLogger.error("Failed to parse login response:", error);
                throw error;
            }

            if (!this.authToken) {
                throw new Error("No auth token received from login response");
            }

            elizaLogger.debug("Login successful");
            return {
                cookies: await this.getCookies(),
                accessToken: this.authToken
            };
        } catch (error) {
            elizaLogger.error("Login error:", error);
            throw error;
        }
    }

    // Add a new method to print current cookies
    public async printCookies(): Promise<void> {
        try {
            const cookies = await this.page.cookies();
            elizaLogger.info("Current cookies:");
            cookies.forEach(cookie => {
                elizaLogger.info(JSON.stringify(cookie, null, 2));
            });
        } catch (error) {
            elizaLogger.error("Failed to get cookies:", error);
        }
    }

    private async getCachedToken(username: string): Promise<string | null> {
        const encryptedToken = await this.runtime.cacheManager.get(`truthsocial/${username}/token`);
        if (!encryptedToken || typeof encryptedToken !== 'string') return null;
        try {
            return await this.encryptionService.decrypt(encryptedToken);
        } catch (error) {
            elizaLogger.error(`Failed to decrypt token: ${error.message}`);
            return null;
        }
    }

    private async cacheToken(username: string, token: string): Promise<void> {
        try {
            const encryptedToken = await this.encryptionService.encrypt(token);
            await this.runtime.cacheManager.set(`truthsocial/${username}/token`, encryptedToken);
        } catch (error) {
            elizaLogger.error(`Failed to encrypt and cache token: ${error.message}`);
            throw error;
        }
    }

    protected async makeAuthenticatedRequest(endpoint: string, method: string = 'GET', params: any = {}) {
        if (!this.authToken) {
            elizaLogger.log("No auth token found, attempting to login...");
            await this.init();
            if (!this.authToken) {
                throw new Error("Not authenticated - failed to obtain auth token");
            }
        }

        try {
            await this.setupBrowser();

            let url = `${API_BASE_URL}${endpoint}`;
            if (method === 'GET' && params) {
                const queryParams = new URLSearchParams(params).toString();
                url = `${url}?${queryParams}`;
            }

            elizaLogger.debug(`Making ${method} request to: ${url}`);

            const response = await this.page.evaluate(async ({ url, method, params, authToken }) => {
                try {
                    const resp = await fetch(url, {
                        method,
                        headers: {
                            'content-type': 'application/json',
                            'Authorization': `Bearer ${authToken}`,
                            'accept': 'application/json, text/plain, */*',
                            'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
                            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                            'referer': 'https://truthsocial.com/',
                            'priority': 'u=1, i',
                            'sec-fetch-dest': 'empty',
                            'sec-fetch-mode': 'cors',
                            'sec-fetch-site': 'same-origin'
                        },
                        body: method === 'POST' ? JSON.stringify(params) : undefined,
                        credentials: 'include'
                    });

                    const text = await resp.text();

                    // Convert headers to a plain object
                    const headers = {};
                    resp.headers.forEach((value, key) => {
                        headers[key] = value;
                    });

                    try {
                        return {
                            ok: resp.ok,
                            status: resp.status,
                            data: JSON.parse(text),
                            headers,
                            rawText: text
                        };
                    } catch {
                        return {
                            ok: resp.ok,
                            status: resp.status,
                            data: text,
                            headers,
                            rawText: text
                        };
                    }
                } catch (fetchError) {
                    return {
                        ok: false,
                        status: 0,
                        data: `Fetch error: ${fetchError.message}`,
                        error: fetchError.toString(),
                        headers: {},
                        rawText: fetchError.message
                    };
                }
            }, {
                url,
                method,
                params: method === 'POST' ? params : undefined,
                authToken: this.authToken
            });

            if (!response.ok) {
                if (response.status === 401) {
                    elizaLogger.log("Auth token expired, attempting to re-login...");
                    await this.login();
                    return await this.makeAuthenticatedRequest(endpoint, method, params);
                }
                elizaLogger.error(`Request failed (${response.status}): ${JSON.stringify(response.data)}`);
                throw new Error(`Request failed: ${response.status} ${JSON.stringify(response.data)}`);
            }

            return response.data;
        } catch (error) {
            elizaLogger.error(`API error (${endpoint}): ${error.message}`);
            throw error;
        }
    }

    static async cleanup() {
        if (ClientBase.browser) {
            await ClientBase.browser.close();
            ClientBase.browser = null;
            ClientBase.page = null;
            ClientBase.authToken = null;  // Clear auth token on cleanup
        }
    }

    private async decryptCookie(cookie: any): Promise<any> {
        try {
            if (!cookie.value) return cookie;
            // Only try to decrypt if the value looks encrypted
            if (!cookie.value.startsWith('enc:')) {
                return cookie;
            }
            const decryptedValue = await this.encryptionService.decrypt(cookie.value.substring(4));
            const decryptedCookie = JSON.parse(decryptedValue);
            return {
                ...cookie,
                ...decryptedCookie
            };
        } catch (error) {
            // Don't log decryption errors for non-encrypted cookies
            return cookie;
        }
    }

    private async encryptCookie(cookie: any): Promise<any> {
        try {
            const cookieString = JSON.stringify(cookie);
            const encryptedValue = await this.encryptionService.encrypt(cookieString);
            return {
                ...cookie,
                value: `enc:${encryptedValue}` // Add prefix to identify encrypted cookies
            };
        } catch (error) {
            elizaLogger.error(`Failed to encrypt cookie: ${error.message}`);
            return cookie;
        }
    }

    async setCookiesFromArray(cookiesArray: any[]) {
        try {
            // Encrypt each cookie's value
            const encryptedCookies = await Promise.all(
                cookiesArray.map(cookie => this.encryptCookie(cookie))
            );

            const cookieStrings = encryptedCookies.map(
                (cookie) =>
                    `${cookie.key}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}; ${
                        cookie.secure ? "Secure" : ""
                    }; ${cookie.httpOnly ? "HttpOnly" : ""}; SameSite=${
                        cookie.sameSite || "Lax"
                    }`
            );
            await this.page.setCookies(cookieStrings);
        } catch (error) {
            elizaLogger.error(`Failed to set encrypted cookies: ${error.message}`);
            throw error;
        }
    }

    async getCookies(): Promise<any[]> {
        try {
            const cookies = await this.page.cookies();
            // Decrypt each cookie's value
            return await Promise.all(
                cookies.map(cookie => this.decryptCookie(cookie))
            );
        } catch (error) {
            elizaLogger.error(`Failed to get decrypted cookies: ${error.message}`);
            return [];
        }
    }

    protected async handlePostActions(
        post: TruthSocialPost,
        username: string,
        truthSocialResponse: TruthSocialActionResponse,
        imageDescriptions: any[],
        roomId: UUID
    ) {
        const executedActions: string[] = [];
        let isGroupPost = false;

        // Helper function to check if error is group related
        const isGroupError = (error: any) => {
            return error?.response?.status === 404 &&
                   (error?.response?.data?.error_code === 'GROUP_NOT_FOUND' ||
                    error?.message?.includes('GROUP_NOT_FOUND') ||
                    error?.message?.includes('You cannot post to this group'));
        };

        // Handle favourite action
        if (truthSocialResponse.favourite) {
            elizaLogger.log(`Favouriting post ${post.id}`);
            try {
                await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/favourite`, 'POST');
                elizaLogger.log(`Successfully favourited post ${post.id}`);
                executedActions.push('FAVOURITE');
            } catch (error) {
                if (isGroupError(error)) {
                    isGroupPost = true;
                    elizaLogger.log(`Post ${post.id} is in a group, skipping favourite action`);
                } else {
                    elizaLogger.error(`Failed to favourite post ${post.id}: ${error.message}`);
                }
            }
        }

        // Handle reblog action
        if (truthSocialResponse.reblog) {
            elizaLogger.log(`Reblogging post ${post.id}`);
            try {
                await this.makeAuthenticatedRequest(`/v1/statuses/${post.id}/reblog`, 'POST');
                elizaLogger.log(`Successfully reblogged post ${post.id}`);
                executedActions.push('REBLOG');
            } catch (error) {
                if (isGroupError(error)) {
                    isGroupPost = true;
                    elizaLogger.log(`Post ${post.id} is in a group, skipping reblog action`);
                } else {
                    elizaLogger.error(`Failed to reblog post ${post.id}: ${error.message}`);
                }
            }
        }

        // If it's a group post, skip quote and reply actions
        if (isGroupPost) {
            elizaLogger.log(`Post ${post.id} is in a group, skipping quote and reply actions`);
            return executedActions;
        }

        // Handle quote action
        if (truthSocialResponse.quote) {
            elizaLogger.log(`Generating quote for post ${post.id}`);
            try {
                const quoteContent = await this.generateContent(post, username, 'QUOTE', imageDescriptions, roomId);
                if (quoteContent) {
                    await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                        status: quoteContent,
                        quote_id: post.id
                    });
                    elizaLogger.log(`Successfully posted quote for ${post.id}`);
                    executedActions.push('QUOTE');
                }
            } catch (error) {
                if (isGroupError(error)) {
                    elizaLogger.log(`Post ${post.id} is in a group, skipping quote action`);
                } else {
                    elizaLogger.error(`Failed to post quote for ${post.id}: ${error.message}`);
                }
            }
        }

        // Handle reply action
        if (truthSocialResponse.reply) {
            elizaLogger.log(`Generating reply for post ${post.id}`);
            try {
                const replyContent = await this.generateContent(post, username, 'REPLY', imageDescriptions, roomId);
                if (replyContent) {
                    await this.makeAuthenticatedRequest('/v1/statuses', 'POST', {
                        status: replyContent,
                        in_reply_to_id: post.id
                    });
                    elizaLogger.log(`Successfully posted reply to ${post.id}`);
                    executedActions.push('REPLY');
                }
            } catch (error) {
                if (isGroupError(error)) {
                    elizaLogger.log(`Post ${post.id} is in a group, skipping reply action`);
                } else {
                    elizaLogger.error(`Failed to post reply to ${post.id}: ${error.message}`);
                }
            }
        }

        return executedActions;
    }

    protected async generateContent(
        post: TruthSocialPost,
        username: string,
        action: string,
        imageDescriptions: any[],
        roomId: UUID
    ): Promise<string | null> {
        try {
            const state = await this.runtime.composeState(
                {
                    userId: this.runtime.agentId,
                    roomId,
                    agentId: this.runtime.agentId,
                    content: {
                        text: post.content,
                        action
                    },
                },
                {
                    currentPost: `ID: ${post.id}\nFrom: ${username}\nText: ${post.content}`,
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
                return this.cleanPostContent(response);
            }
            return null;
        } catch (error) {
            elizaLogger.error(`Failed to generate ${action} content: ${error.message}`);
            return null;
        }
    }

    protected cleanPostContent(content: string): string {
        return content
            // Replace paragraph tags with newlines
            .replace(/<p>/g, '')
            .replace(/<\/p>/g, '\n\n')
            // Replace line breaks
            .replace(/<br\s*\/?>/g, '\n')
            // Replace common HTML entities
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&mdash;/g, '—')
            .replace(/&ndash;/g, '–')
            .replace(/&hellip;/g, '...')
            // Handle emoji and unicode entities
            .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) =>
                String.fromCodePoint(parseInt(hex, 16))
            )
            .replace(/&#(\d+);/g, (match, dec) =>
                String.fromCodePoint(parseInt(dec, 10))
            )
            // Remove any other HTML tags
            .replace(/<[^>]*>/g, '')
            // Fix multiple spaces
            .replace(/\s+/g, ' ')
            // Fix multiple newlines
            .replace(/\n\s*\n\s*\n/g, '\n\n')
            // Remove spaces before punctuation
            .replace(/\s+([.,!?])/g, '$1')
            // Ensure space after punctuation
            .replace(/([.,!?])([^\s])/g, '$1 $2')
            // Trim whitespace
            .trim();
    }

    // Add method to set cookies
    public async setCookies(cookiesArray: Array<any>): Promise<void> {
        try {
            await this.setupBrowser();
            await this.page.setCookie(...cookiesArray);
            elizaLogger.info("Cookies set successfully");
        } catch (error) {
            elizaLogger.error("Failed to set cookies:", error);
            throw error;
        }
    }

    // Update formatCookiesForEnv to return the raw array instead of stringified version
    private formatCookiesForEnv(cookies: Array<any>): Array<any> {
        return cookies.filter(cookie =>
            cookie.name === '_mastodon_session' ||
            cookie.name === '__cf_bm' ||
            cookie.name === '__cflb' ||
            cookie.name === '_cfuvid'
        ).map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            expires: cookie.expires,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            session: cookie.session,
            sameSite: cookie.sameSite
        }));
    }

    // Update exportCookiesAsJSON to return escaped JSON
    public async exportCookiesAsJSON(): Promise<string> {
        try {
            const cookies = await this.page.cookies();
            const formattedCookies = this.formatCookiesForEnv(cookies);
            return JSON.stringify(JSON.stringify(formattedCookies));
        } catch (error) {
            elizaLogger.error("Failed to export cookies:", error);
            throw error;
        }
    }

    protected async authenticate() {
        // If we have cookies and auth token, use those
        if (this.config.TRUTHSOCIAL_COOKIES && this.config.TRUTHSOCIAL_AUTH_TOKEN) {
            elizaLogger.debug("Set these as your environment variables:");
            elizaLogger.debug(`TRUTHSOCIAL_COOKIES='${this.config.TRUTHSOCIAL_COOKIES}'`);
            elizaLogger.debug(`TRUTHSOCIAL_AUTH_TOKEN='${this.config.TRUTHSOCIAL_AUTH_TOKEN}'`);
            return;
        }

        // Otherwise, perform login
        const response = await this.login();
        elizaLogger.debug("Set these as your environment variables:");
        elizaLogger.debug(`TRUTHSOCIAL_COOKIES='${JSON.stringify(response.cookies)}'`);
        elizaLogger.debug(`TRUTHSOCIAL_AUTH_TOKEN='${response.accessToken}'`);
        elizaLogger.debug("Login successful");
    }
}