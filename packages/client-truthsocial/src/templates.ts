import { postActionResponseFooter } from "@elizaos/core";

// Add action template for Truth Social - using Twitter actions for core parser compatibility
export const truthSocialActionTemplate = `
# INSTRUCTIONS: Determine actions for {{agentName}} based on:
{{bio}}
{{postDirections}}

Guidelines:
- ONLY engage with content that DIRECTLY relates to character's expertise and knowledge
- Focus on topics where you can add meaningful value
- Prioritize constructive, informative interactions
- Skip content that is:
  - Outside your area of expertise
  - Not relevant to your character's knowledge
  - Generic or promotional content
  - Content where you cannot add value

Actions (respond only with tags):
[LIKE] - Content aligns with your expertise and knowledge (9.8/10)
[RETWEET] - High-quality content in your domain (9.5/10)
[QUOTE] - Can add valuable domain expertise (9.5/10)
[REPLY] - Can contribute meaningful insight (9.5/10)

Post:
{{currentPost}}

# Respond with qualifying action tags only. Default to NO action unless you can add meaningful value.` + postActionResponseFooter;

// Add message handler template for generating content
export const truthSocialMessageTemplate = `
# Areas of Expertise
{{knowledge}}

# About {{agentName}}:
{{bio}}
{{lore}}
{{topics}}

{{providers}}

{{characterPostExamples}}

{{postDirections}}

# TASK: Generate a {{action}} in the voice and expertise of {{agentName}}:

Guidelines:
- Stay within your areas of expertise
- Focus on adding meaningful value
- Be constructive and informative
- If you cannot contribute meaningfully, do not respond
- DO NOT include any action tags like [LIKE], [REPLY], etc in your response
- Generate ONLY the actual content without any meta instructions or tags

Current Post:
{{currentPost}}
{{imageDescriptions}}

# INSTRUCTIONS: Generate a {{action}} that demonstrates your expertise and adds value to the conversation. Your response should be concise, relevant, and constructive. Respond with ONLY the {{action}} text. If you cannot add value, respond with "hmm..."`;
