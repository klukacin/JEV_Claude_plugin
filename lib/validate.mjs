// lib/validate.mjs — checks question shapes before they are sent, so errors name the field, not a 422.
const TYPES = new Set(['noul', 'choice', 'score']);
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function validateQuestion(q, id = 'question') {
  if (!isPlainObject(q)) throw new Error(`${id}: must be an object with type and instructions`);
  if (!TYPES.has(q.type)) throw new Error(`${id}: type must be noul, choice, or score`);
  const ins = q.instructions;
  const ok = (typeof ins === 'string' && ins.trim().length > 0) || isPlainObject(ins) || (Array.isArray(ins) && ins.length > 0);
  if (!ok) throw new Error(`${id}: instructions must be a non-empty string, object, or array`);
  if (q.type === 'choice') {
    if (!isPlainObject(q.criteria) || Object.keys(q.criteria).length < 1) throw new Error(`${id}: choice needs criteria as a map of option -> description`);
    if (Object.keys(q.criteria).length > 255) throw new Error(`${id}: choice supports at most 255 options`);
  }
  if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > 10)) {
    throw new Error(`${id}: score needs criteria as an ordered array of 2-10 level descriptions`);
  }
  if (q.type === 'noul' && q.criteria !== undefined && !isPlainObject(q.criteria)) {
    throw new Error(`${id}: noul criteria must be an object with optional true/false descriptions`);
  }
  return true;
}

export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) throw new Error('questions must be a non-empty object of id -> question');
  for (const [id, q] of Object.entries(questions)) validateQuestion(q, id);
  return true;
}
