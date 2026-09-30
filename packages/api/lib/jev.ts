/**
 * jev.ts
 *
 * Client and clustering engine using OpenRouter's Decisions API and TypeSafe JEV.
 * Performs fast, calibrated classification of recordings into semantic clusters.
 */

import { getJevModel, getLlmModel, llmClient } from './llm';

export interface ClusterDefinition {
  id: string;
  name: string;
  description: string;
}

export interface ClusteredMomentsResult {
  lens: string;
  generatedAt: string;
  clusters: {
    id: string;
    name: string;
    description: string;
    recordingIds: string[];
  }[];
}

export interface RecordingForClustering {
  id: string;
  title: string;
  summary?: string | null;
  tags?: string[];
  keyTakeaways?: string[];
}

export const PRESET_LENSES: Record<string, { label: string; clusters: ClusterDefinition[] }> = {
  domain: {
    label: 'Work & Life',
    clusters: [
      { id: 'work_projects', name: 'Work & Projects', description: 'Professional tasks, meetings, architecture, code, and project management' },
      { id: 'personal_life', name: 'Personal & Family', description: 'Personal affairs, daily routines, family, health, and home life' },
      { id: 'creative_ideas', name: 'Ideas & Brainstorming', description: 'Creative concepts, exploratory thoughts, future plans, and new initiatives' },
      { id: 'logistics_admin', name: 'Logistics & Daily', description: 'Errands, reminders, scheduling, shopping, and administrative notes' },
    ],
  },
  intent: {
    label: 'By Intent',
    clusters: [
      { id: 'decisions', name: 'Decisions & Commitments', description: 'Resolutions, agreements, decided actions, and strategy commitments' },
      { id: 'updates_status', name: 'Status & Updates', description: 'Progress reports, standups, catchups, and state-of-play discussions' },
      { id: 'exploration_learn', name: 'Exploration & Learning', description: 'Research, learning sessions, deep dives, and open discussions' },
      { id: 'casual_connection', name: 'Casual & Social', description: 'Informal chats, social interactions, storytelling, and casual banter' },
    ],
  },
};

/**
 * Call OpenRouter's Decisions API with JEV.
 * POST https://openrouter.ai/api/alpha/decisions
 */
async function callJevDecisions(state: string, choices: Record<string, string>): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return null;

  const baseURL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
  // Derive OpenRouter root url: https://openrouter.ai/api/alpha/decisions
  const decisionsURL = baseURL.replace(/\/v1\/?$/, '/alpha/decisions');
  const model = getJevModel();

  try {
    const res = await fetch(decisionsURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://walfly.app',
        'X-OpenRouter-Title': 'Walfly Moments Clustering',
      },
      body: JSON.stringify({
        model,
        state,
        questions: {
          category: {
            type: 'choice',
            instructions: 'Select the best matching cluster for this recording.',
            criteria: choices,
          },
        },
      }),
    });

    if (!res.ok) {
      console.warn(`[JEV] decisions API returned status ${res.status}: ${await res.text()}`);
      return null;
    }

    const json = await res.json();
    const categoryAnswer = json?.answers?.category;
    if (categoryAnswer?.type === 'choice' && typeof categoryAnswer.choice === 'string') {
      return categoryAnswer.choice;
    }
    return null;
  } catch (err) {
    console.error('[JEV] decision request failed:', err);
    return null;
  }
}

/**
 * Synthesize 3-6 dynamic cluster definitions based on actual recording metadata using the primary LLM.
 */
async function generateDynamicClusters(recordings: RecordingForClustering[]): Promise<ClusterDefinition[]> {
  const sample = recordings.slice(0, 30).map((r) => ({
    title: r.title,
    tags: r.tags || [],
    summarySnippet: (r.summary || '').slice(0, 150),
  }));

  const client = llmClient();
  const model = getLlmModel();

  const prompt = `Analyze these ${sample.length} audio recording moments and create 3 to 6 logical, non-overlapping cluster themes to organize them.
Respond with ONLY a JSON object of this structure:
{
  "clusters": [
    {
      "id": "slug_id",
      "name": "Short Human-Friendly Name",
      "description": "Clear 1-sentence criteria explaining what fits in this cluster"
    }
  ]
}

Recordings:
${JSON.stringify(sample, null, 2)}`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const content = response.choices[0]?.message?.content;
    if (content) {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.clusters) && parsed.clusters.length >= 2) {
        return parsed.clusters.map((c: any, idx: number) => ({
          id: String(c.id || `cluster_${idx + 1}`).toLowerCase().replace(/[^a-z0-9_]/g, '_'),
          name: String(c.name || `Topic ${idx + 1}`),
          description: String(c.description || ''),
        }));
      }
    }
  } catch (err) {
    console.warn('[JEV] Dynamic cluster generation failed, falling back to default clusters:', err);
  }

  return [
    { id: 'projects', name: 'Projects & Work', description: 'Tasks, planning, coding, and architecture' },
    { id: 'ideas', name: 'Ideas & Thoughts', description: 'Brainstorms, random concepts, and insights' },
    { id: 'conversations', name: 'Conversations & Social', description: 'Discussions, catchups, and meetings' },
    { id: 'daily', name: 'Daily & General', description: 'Everyday notes, life, and personal items' },
  ];
}

/**
 * Perform classification of recordings against a set of cluster definitions using JEV (or fast fallback).
 */
export async function clusterRecordingsWithJev(
  lens: string,
  recordings: RecordingForClustering[],
  options?: { customClusters?: ClusterDefinition[] }
): Promise<ClusteredMomentsResult> {
  if (recordings.length === 0) {
    return {
      lens,
      generatedAt: new Date().toISOString(),
      clusters: [],
    };
  }

  let clusters: ClusterDefinition[];

  if (lens === 'dynamic') {
    clusters = options?.customClusters || (await generateDynamicClusters(recordings));
  } else if (PRESET_LENSES[lens]) {
    clusters = PRESET_LENSES[lens].clusters;
  } else {
    // Default to dynamic
    clusters = await generateDynamicClusters(recordings);
  }

  const choicesCriteria: Record<string, string> = {};
  for (const c of clusters) {
    choicesCriteria[c.id] = `${c.name}: ${c.description}`;
  }

  const clusterBuckets: Record<string, string[]> = {};
  for (const c of clusters) {
    clusterBuckets[c.id] = [];
  }
  const unassigned: string[] = [];

  // Classify recordings in parallel batches with JEV
  const BATCH_SIZE = 8;
  for (let i = 0; i < recordings.length; i += BATCH_SIZE) {
    const batch = recordings.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (rec) => {
        const state = `Title: ${rec.title}\nTags: ${(rec.tags || []).join(', ')}\nSummary: ${rec.summary || ''}\nKey Takeaways: ${(rec.keyTakeaways || []).join('; ')}`;
        const chosenId = await callJevDecisions(state, choicesCriteria);

        if (chosenId && clusterBuckets[chosenId]) {
          clusterBuckets[chosenId].push(rec.id);
        } else {
          // Fallback: heuristic match based on keyword/title or place in first bucket
          const matched = clusters.find((c) =>
            rec.title.toLowerCase().includes(c.name.toLowerCase()) ||
            (rec.tags || []).some((t) => c.name.toLowerCase().includes(t.toLowerCase()))
          );
          if (matched) {
            clusterBuckets[matched.id].push(rec.id);
          } else {
            unassigned.push(rec.id);
          }
        }
      })
    );
  }

  const resultClusters = clusters.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    recordingIds: clusterBuckets[c.id] || [],
  }));

  // If there are unassigned items, add a clear "Other & General" bucket
  if (unassigned.length > 0) {
    resultClusters.push({
      id: 'uncategorized',
      name: 'Other & General',
      description: 'Moments that do not neatly fit into the main categories above',
      recordingIds: unassigned,
    });
  }

  return {
    lens,
    generatedAt: new Date().toISOString(),
    clusters: resultClusters,
  };
}
