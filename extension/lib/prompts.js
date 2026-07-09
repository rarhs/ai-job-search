// Prompt builders ported from .claude/skills/job-application-assistant/
// (04-job-evaluation.md scoring framework, 03-writing-style.md letter rules).

export const WEIGHTS = {
  technical_skills: 0.30,
  experience: 0.25,
  behavioral: 0.15,
  career: 0.30,
};

export function verdictFor(overall) {
  if (overall >= 75) return 'Strong Fit';
  if (overall >= 60) return 'Good Fit';
  if (overall >= 45) return 'Moderate Fit';
  if (overall >= 30) return 'Weak Fit';
  return 'Poor Fit';
}

// The model proposes per-dimension scores; the popup recomputes the weighted
// overall so verdict thresholds are enforced by code, not by the model.
export function computeOverall(evaluation) {
  let total = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS)) {
    const score = Number(evaluation?.[dim]?.score);
    if (!Number.isFinite(score)) return null;
    total += Math.max(0, Math.min(100, score)) * weight;
  }
  return Math.round(total);
}

export function buildEvaluationRequest(profile, jobText) {
  const system = [
    'You are a rigorous career advisor. Evaluate how well a candidate fits a job posting.',
    'Score honestly. Do not inflate scores to be encouraging; gaps must be named plainly.',
    '',
    'Score these dimensions 0-100:',
    '- technical_skills: 80-100 core requirements are primary skills; 60-79 most match with 1-2 learnable gaps; 40-59 partial match, significant upskilling; 0-39 fundamental mismatch.',
    '- experience: 80-100 direct experience in same domain and role type; 60-79 related with clear transferable skills; 40-59 adjacent, case must be made; 0-39 unrelated.',
    '- behavioral: culture/work-style match between what the posting signals and the candidate profile. 80-100 strong match; 60-79 mostly compatible; 40-59 some friction; 0-39 significant mismatch.',
    '- career: alignment with the candidate\'s stated goals and what energizes them. 80-100 strongly aligned with a clear growth path; 60-79 good role, partial alignment; 40-59 does not build toward goals; 0-39 dead end or backwards step.',
    '- location: PASS, FAIL, or FLAG (not a number). FAIL only on a hard conflict with the candidate\'s stated constraints (e.g. relocation required). FLAG when unclear or requires discussion (e.g. frequent travel). PASS otherwise.',
    '',
    'Respond with ONLY a JSON object, no markdown fences, matching exactly:',
    '{',
    '  "role": string, "company": string,',
    '  "technical_skills": {"score": number, "note": string},',
    '  "experience": {"score": number, "note": string},',
    '  "behavioral": {"score": number, "note": string},',
    '  "career": {"score": number, "note": string},',
    '  "location": {"status": "PASS"|"FAIL"|"FLAG", "note": string},',
    '  "strengths": [string, ...],   // key strengths for THIS role, 2-5 items',
    '  "gaps": [string, ...],        // gaps to address, 0-5 items, honest',
    '  "recommendation": string      // 1-2 sentences: apply / skip / apply with caveats',
    '}',
    'Notes must be brief (max ~15 words). If the page text does not look like a job posting, still respond with the JSON but set every note to explain the problem and scores to 0.',
  ].join('\n');

  const user = [
    '## Candidate profile',
    profile,
    '',
    '## Job posting (extracted from web page, may contain navigation noise)',
    jobText,
  ].join('\n');

  return { system, user };
}

export function buildCoverLetterRequest(profile, jobText, evaluation) {
  const system = [
    'You draft cover letters. Follow every rule strictly:',
    '- Write in the same language as the job posting.',
    '- NO em-dashes. Use commas, periods, or restructure.',
    '- NO cliches or filler: never "passionate about", "great fit", "leverage my skills", "hit the ground running", "drive results", "synergies".',
    '- NO buzzwords without concrete backing; every claim needs a specific example or fact from the profile.',
    '- NO apologetic language. Not "I think I could contribute" but "I bring X, demonstrated by Y."',
    '- NO fabrication. Use only facts present in the candidate profile. Apply the interview backtrack test: nothing the candidate could not comfortably defend live. Acknowledge a key gap honestly rather than papering over it.',
    '- NO invented company facts. Only reference company specifics that appear in the posting text itself.',
    '- Forward-looking framing: focus on which of the employer\'s tasks the candidate can solve and how, with 1-2 brief past examples as backing. Not a CV repetition.',
    '- Structure: opening states the role and connects background to it in 2-3 sentences; early paragraph on why this specific company; body focused on task-solving, optionally one 3-5 bullet list of concrete outcome-oriented skills; brief confident close.',
    '- Tone: warm but direct, conversational professional, first person, active voice.',
    '- Length: fits one page, roughly 250-350 words.',
    '- Output ONLY the letter body as plain text. No subject line, no addresses, no date, no "Dear..." salutation placeholder explanation, and no commentary. Start with the salutation (use the contact person named in the posting, otherwise "Dear Hiring Manager,").',
  ].join('\n');

  const user = [
    '## Candidate profile',
    profile,
    '',
    '## Job posting',
    jobText,
    '',
    '## Fit evaluation summary (for emphasis, strengths to lead with, gaps to handle honestly)',
    JSON.stringify(evaluation),
  ].join('\n');

  return { system, user };
}

// Tolerates ```json fences and stray prose around the object.
export function parseModelJson(text) {
  const trimmed = String(text).trim();
  const candidates = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.unshift(fence[1]);
  const braces = trimmed.match(/\{[\s\S]*\}/);
  if (braces) candidates.push(braces[0]);
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error('Model did not return valid JSON');
}

export function buildProfileImportRequest(rawCv) {
  const system = [
    'You are a CV importer. Convert raw CV / LinkedIn / bio text into a structured candidate profile in plain markdown.',
    'Sections (omit a section entirely if the input has nothing for it):',
    '## Identity — name, location, commute/relocation constraints, languages',
    '## Education — degree, field, institution, years, thesis topic',
    '## Experience — one entry per role: title, company, dates, 2-4 concrete achievement bullets',
    '## Skills — Primary (deep, recent) vs Secondary (working knowledge); tools/software',
    '## Certifications and publications',
    '## Career goals and preferences — goals, what energizes/drains, ideal environment',
    'Rules: use ONLY facts present in the input, never invent or embellish; keep the original language of the CV;',
    'condense prose into scannable bullets; where a critical fact is missing write "(not stated)".',
    'Output ONLY the markdown profile, no commentary.',
  ].join('\n');
  return { system, user: rawCv };
}
