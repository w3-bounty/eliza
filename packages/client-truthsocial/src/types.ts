import { ActionResponse } from "@elizaos/core";

export interface TruthSocialPost {
    id: string;
    created_at: string;
    content: string;
    url: string;
    reblogs_count: number;
    favourites_count: number;
    in_reply_to_id?: string;
    in_reply_to_account_id?: string;
    sensitive?: boolean;
    spoiler_text?: string;
    visibility: 'public' | 'unlisted' | 'private' | 'direct';
    media_attachments?: Array<{
        id: string;
        type: string;
        url: string;
        preview_url: string;
        description?: string;
    }>;
    account: TruthSocialAccount;
    mentions: Array<{
        id: string;
        username: string;
        url: string;
        acct: string;
    }>;
    reblog?: TruthSocialPost;
    quote?: TruthSocialPost;
}

export interface TruthSocialAccount {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    note: string;
    url: string;
    avatar: string;
    followers_count: number;
    following_count: number;
    statuses_count: number;
}

export interface TruthSocialUser {
    id: string;
    username: string;
    acct: string;
    display_name: string;
    note: string;
    url: string;
    avatar: string;
    followers_count: number;
    following_count: number;
    statuses_count: number;
}

export interface TruthSocialActionResponse extends ActionResponse {
    favourite?: boolean;
    reblog?: boolean;
    quote?: boolean;
    reply?: boolean;
    follow_back?: boolean;
}

export type NotificationType =
    | 'mention'
    | 'favourite'
    | 'reblog'
    | 'follow'
    | 'group_favourite'
    | 'group_reblog'
    | 'group_mention'
    | 'poll'
    | 'poll_owned'
    | 'status';

export interface TruthSocialSearchOptions {
    q: string;
    type: 'accounts' | 'statuses' | 'hashtags';
    resolve?: boolean;
    limit?: number;
    offset?: number;
    min_id?: string;
    max_id?: string;
}

export interface TruthSocialTimelineOptions {
    exclude_replies?: boolean;
    pinned?: boolean;
    with_muted?: boolean;
    max_id?: string;
    limit?: number;
}