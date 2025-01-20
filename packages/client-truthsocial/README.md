# Truth Social Client for Eliza

This package provides Truth Social integration for Eliza agents, allowing them to interact with Truth Social's platform through automated posting, monitoring, and engagement capabilities.

## Features

- Automated authentication and session management
- Post creation and scheduling
- Search functionality with configurable intervals
- Automated engagement (likes, reblogs, quotes, replies)
- Media attachment handling and image processing
- Content summarization for long posts
- Secure token encryption
- Notification monitoring

## Installation

Add the following to your character.json file:

```json
    "clients": [
        "truthsocial"
    ],
```

## Configuration

Add the following to your `.env` file:

```env
# Required Settings
TRUTHSOCIAL_USERNAME=               # Your Truth Social username
TRUTHSOCIAL_PASSWORD=               # Your Truth Social password

# Monitoring Settings
TRUTHSOCIAL_TARGET_USERS=           # Comma-separated list of users to monitor
TRUTHSOCIAL_NOTIFICATION_CHECK_INTERVAL=15  # How often to check notifications (minutes)
TRUTHSOCIAL_SEARCH_CHECK_INTERVAL=15        # How often to check search results (minutes)

# Post Settings
TRUTHSOCIAL_POST_INTERVAL_MIN=90    # Minimum interval between posts (minutes)
TRUTHSOCIAL_POST_INTERVAL_MAX=180   # Maximum interval between posts (minutes)
TRUTHSOCIAL_POST_IMMEDIATELY=false  # Post immediately on startup
TRUTHSOCIAL_MAX_POST_LENGTH=500    # Max post length before summarization

# Feature Settings
TRUTHSOCIAL_PROCESS_IMAGES=true     # Enable image processing in posts
TRUTHSOCIAL_RETRY_LIMIT=3          # Maximum retry attempts for operations
```

## Usage

### Basic Setup

```typescript
import { TruthSocialClient } from '@elizaos/client-truthsocial';

// Initialize the client
const client = new TruthSocialClient(runtime, config);
await client.init();

// Start the posting loop
await client.startPostingLoop();

// Start monitoring specific users (if configured)
if (config.TRUTHSOCIAL_TARGET_USERS?.length > 0) {
    await client.startMonitoring();
}
```

### Posting Content

```typescript
// Create a new post
await client.createPost("Hello Truth Social! #MAGA");

// Post with media
await client.createPost("Check out this image!", {
    mediaIds: ['media_id_here']
});
```

### Monitoring and Search

```typescript
// Monitor specific users
const users = ['AmericanAF', 'OtherUser'];
await client.startMonitoring(users);

// Stop monitoring
await client.stopMonitoring();

// Search for posts
const posts = await client.searchPosts('query', 40);

// Search for users
const users = await client.searchUsers('username');

// Get user timeline
const timeline = await client.getUserTimeline('username', {
    exclude_replies: true,
    limit: 20
});
```

## Security Features

The client includes several security features:

- Encrypted token storage using machine-specific encryption
- Secure session management
- Rate limiting protection
- Automatic token refresh
- Browser fingerprint simulation

## Browser Automation

The client uses Puppeteer and several plugins for browser automation:

- `puppeteer-extra`: Enhanced version of Puppeteer with plugin support
- `puppeteer-extra-plugin-stealth`: Applies various evasion techniques to make automation undetectable
- `puppeteer-extra-plugin-adblocker`: Blocks ads and trackers for better performance

These dependencies are automatically installed and managed, including a headless Chrome browser. No manual browser installation is required.

## Memory Management

The client implements smart memory management features:

- Tracks processed posts to prevent duplicate actions
- Stores initial posts without taking actions when monitoring new users
- Maintains efficient memory usage through periodic cleanup
- Implements configurable post length limits with automatic summarization

