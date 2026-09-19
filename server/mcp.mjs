#!/usr/bin/env node
// server/mcp.mjs — the jev MCP server: Jev's three primitives as tools, plus batch and route.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { createClient } from '../lib/jev-client.mjs';
import { createServer, serve } from '../lib/mcp-protocol.mjs';
import { validateQuestion, validateQuestions } from '../lib/validate.mjs';
import { buildRouter, decideTier } from '../lib/questions.mjs';
import { num } from '../lib/util.mjs';

export const SERVER_VERSION = '0.1.0';
export const INSTRUCTIONS = 'Jev (TypeSafe System One) returns typed answers with calibrated probabilities in about 200 ms: choose one option, place on an ordered scale, or answer yes/no. Use it for judgments whose possible answers can be listed up front, for classifying or ranking many items the same way, and for picking a model tier for a subtask. Never for generating text or code. Calls send the supplied state to TypeSafe and are billed to the configured key.';

const ANNOTATIONS = { readOnlyHint: true, openWorldHint: true };
const STATE = { type: ['string', 'object', 'array'], description: 'What to judge: plain text, or a JSON object/array with named fields. Send only what the questions need.' };
const INSTR = { type: ['string', 'object', 'array'], description: 'The judgment to make, stated as the exact condition or question. A string, or an object/array with definitions, contrasts, and examples.' };
const MODEL = { type: 'string', description: 'Jev model id; defaults to the configured model (jev-latest).' };
export const QUESTION_SCHEMA = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['noul', 'choice', 'score'], description: 'noul = probability a yes/no condition holds; choice = one option from criteria; score = probability-weighted position on ordered criteria levels.' },
    instructions: INSTR,
    criteria: { description: 'noul: optional {"true": "...", "false": "..."}; choice (required): map of option -> description, up to 255; score (required): ordered array of 2-10 level descriptions, low to high.' },
  },
  required: ['type', 'instructions'],
};

export function isMainModule(argv1, moduleUrl) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return path.resolve(argv1) === fileURLToPath(moduleUrl);
  }
}

export async function runWithConcurrency(fns, limit) {
  const results = new Array(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, fns.length)) }, worker));
  return results;
}

export function buildTools({ client, cfg }) {
  const call = (req) => client.systemOne(req, { timeoutMs: cfg.toolTimeoutMs });

  return [
    {
      name: 'decide',
      description: 'Ask Jev several typed questions about one state in a single round trip. Each question is {type: noul|choice|score, instructions, criteria}; answers come back under the same ids with probabilities and confidence. Use for multi-dimension judgments about one thing (kind + severity + flags) or when the other tools do not fit.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, questions: { type: 'object', additionalProperties: QUESTION_SCHEMA, minProperties: 1, description: 'Map of question id -> question. Ids are for you; they are not sent to the model.' }, model: MODEL },
        required: ['state', 'questions'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, questions, model }) {
        validateQuestions(questions);
        const r = await call({ state, questions, model });
        return { model: r.model, answers: r.answers, usage: r.usage };
      },
    },
    {
      name: 'choose',
      description: 'Pick exactly one of up to 255 labelled options for the given state. Returns the winning option, per-option probabilities, and confidence. Use for routing, categorization, intent, or picking an approach. Add an "other" option when nothing may fit.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, options: { type: 'object', additionalProperties: { type: ['string', 'object', 'null'] }, minProperties: 1, description: 'Map of option -> description of what it covers (and what it is not for).' }, model: MODEL },
        required: ['state', 'instructions', 'options'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, options, model }) {
        const q = { type: 'choice', instructions, criteria: options };
        validateQuestion(q, 'options');
        const a = (await call({ state, questions: { result: q }, model })).answers.result;
        return { choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
      },
    },
    {
      name: 'score',
      description: 'Place the state on an ordered scale of 2-10 levels you describe, low to high. Returns a fractional score (2.3 = mostly level 2 with some level 3), the nearest level, the legend, and confidence. Use for risk, severity, urgency, quality, readiness. Describe levels as concrete situations.',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, levels: { type: 'array', items: { type: ['string', 'object'] }, minItems: 2, maxItems: 10, description: 'Ordered level descriptions, lowest first.' }, model: MODEL },
        required: ['state', 'instructions', 'levels'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, levels, model }) {
        const q = { type: 'score', instructions, criteria: levels };
        validateQuestion(q, 'levels');
        const a = (await call({ state, questions: { result: q }, model })).answers.result;
        const s = num(a.score);
        const nearest = s === null ? null : Math.max(0, Math.min(levels.length - 1, Math.round(s)));
        return {
          score: s, max: levels.length - 1, nearest_level: nearest,
          nearest_level_description: nearest === null ? null : (typeof levels[nearest] === 'string' ? levels[nearest] : JSON.stringify(levels[nearest])),
          legend: a.legend, probabilities: a.probabilities, confidence: a.confidence,
        };
      },
    },
    {
      name: 'check',
      description: 'Answer a yes/no question about the state as a calibrated probability from 0 to 1. Use for gates, filters, and verifying that a stated condition holds. A value near 0.5 means undecided, not "medium".',
      inputSchema: {
        type: 'object',
        properties: { state: STATE, instructions: INSTR, criteria: { type: 'object', properties: { true: { type: ['string', 'object'] }, false: { type: ['string', 'object'] } }, description: 'Optional descriptions of what counts as yes and as no.' }, model: MODEL },
        required: ['state', 'instructions'],
      },
      annotations: ANNOTATIONS,
      async handler({ state, instructions, criteria, model }) {
        const q = { type: 'noul', instructions, ...(criteria ? { criteria } : {}) };
        validateQuestion(q, 'check');
        const p = num((await call({ state, questions: { result: q }, model })).answers.result.noul);
        return { probability: p, likely: p !== null && p >= 0.5 };
      },
    },
  ];
}

export function main() {
  const cfg = loadConfig();
  const client = createClient({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model });
  const server = createServer({ name: 'jev', version: SERVER_VERSION, instructions: INSTRUCTIONS, tools: buildTools({ client, cfg }) });
  process.stderr.write(`jev mcp ready · model=${cfg.model} · endpoint=${cfg.baseUrl} · key=${cfg.apiKey ? 'set' : 'MISSING'}\n`);
  serve(server);
}

if (isMainModule(process.argv[1], import.meta.url)) main();
