import { elizaLogger, stringToUuid, State, composeContext, generateText, ModelClass, IAgentRuntime } from "@elizaos/core";

// Add summarization template
export const truthSocialSummarizationTemplate = `
# TASK: Summarize the following post in a concise way (max 250 characters) while preserving the key points and sentiment:

Post Content:
{{content}}

# INSTRUCTIONS: Your summary should:
1. Capture the main message/point
2. Preserve important facts or data
3. Maintain the original tone
4. Be clear and coherent
5. Not exceed 250 characters`;

export const MAX_POST_LENGTH = 500; // Threshold for when to summarize

export function cleanPostContent(content: string): string {
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

export async function summarizeContent(content: string, runtime: IAgentRuntime): Promise<string | null> {
    if (!content?.trim()) {
        elizaLogger.warn('Empty content provided to summarizeContent');
        return null;
    }

    const state = await runtime.composeState({
        userId: runtime.agentId,
        roomId: stringToUuid("summarization"),
        agentId: runtime.agentId,
        content: {
            text: content,
            action: "SUMMARIZE"
        }
    });

    const context = composeContext({
        state,
        template: truthSocialSummarizationTemplate
    });

    try {
        const summary = await generateText({
            runtime,
            context,
            modelClass: ModelClass.SMALL
        });

        if (!summary?.trim()) {
            elizaLogger.warn('Generated summary is empty, returning original content');
            return content;
        }

        // Clean the generated summary
        const cleanedSummary = cleanPostContent(summary);
        if (!cleanedSummary?.trim()) {
            elizaLogger.warn('Cleaned summary is empty, returning original content');
            return content;
        }

        return cleanedSummary;
    } catch (error) {
        elizaLogger.error(`Failed to generate summary: ${error.message}`);
        return content;
    }
}

export async function processContent(content: string, runtime: IAgentRuntime): Promise<{ processedContent: string, isSummarized: boolean }> {
    if (!content?.trim()) {
        elizaLogger.warn('Empty content provided to processContent');
        return { processedContent: '', isSummarized: false };
    }

    try {
        const cleanedContent = cleanPostContent(content);
        if (!cleanedContent?.trim()) {
            elizaLogger.warn('Cleaned content is empty');
            return { processedContent: '', isSummarized: false };
        }

        if (cleanedContent.length > MAX_POST_LENGTH) {
            elizaLogger.log(`Content exceeds length limit (${cleanedContent.length} chars), generating summary`);
            const summary = await summarizeContent(cleanedContent, runtime);

            if (!summary?.trim()) {
                elizaLogger.warn('Summary generation failed, using cleaned content');
                return { processedContent: cleanedContent, isSummarized: false };
            }

            return {
                processedContent: summary,
                isSummarized: true
            };
        }

        return {
            processedContent: cleanedContent,
            isSummarized: false
        };
    } catch (error) {
        elizaLogger.error(`Error processing content: ${error.message}`);
        return { processedContent: '', isSummarized: false };
    }
}