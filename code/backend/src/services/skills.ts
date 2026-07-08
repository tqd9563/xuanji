import { config } from '../config.js';
import { scanSkills } from '../adapters/claude-dir.js';
import type { Skill } from '../types.js';

let cached: { at: number; skills: Skill[] } | null = null;
const CACHE_MS = 30_000;

export async function listSkills(): Promise<Skill[]> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.skills;
  const skills = await scanSkills(config.claudeDir);
  skills.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
  cached = { at: Date.now(), skills };
  return skills;
}

export function invalidateSkillsCache() {
  cached = null;
}
