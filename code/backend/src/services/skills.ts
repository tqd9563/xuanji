import { config } from '../config.js';
import { scanSkills } from '../adapters/claude-dir.js';
import { lookupUsage, maybeRefreshSkillUsage, skillUsageMap } from './skill-usage.js';
import type { Storage } from '../storage/db.js';
import type { Skill } from '../types.js';

let cached: { at: number; skills: Skill[] } | null = null;
const CACHE_MS = 30_000;

/**
 * 技能列表。带 storage 时附上触发统计:计数直接读索引(毫秒级),
 * 索引本身按需在后台增量刷新——列表不等扫描,首次访问可能读到略旧的数字。
 */
export async function listSkills(storage?: Storage): Promise<Skill[]> {
  if (!(cached && Date.now() - cached.at < CACHE_MS)) {
    const skills = await scanSkills(config.claudeDir);
    skills.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
    cached = { at: Date.now(), skills };
  }
  if (!storage) return cached.skills;

  maybeRefreshSkillUsage(storage);
  const usage = skillUsageMap(storage);
  // usage 每次现读:技能目录 30s 缓存,但计数要跟着后台扫描及时更新
  return cached.skills.map((s) => ({ ...s, usage: lookupUsage(usage, s.name) }));
}

export function invalidateSkillsCache() {
  cached = null;
}
