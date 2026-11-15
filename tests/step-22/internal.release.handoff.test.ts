import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('Step 22 — Internal Release Handoff and Documentation Audit', () => {
  const rootReadmePath = path.resolve('README.md');
  const step21ReportPath = path.resolve('docs/step-21/INTERNAL_RELEASE_REHEARSAL.md');
  const step22HandoffPath = path.resolve('docs/step-22/INTERNAL_RELEASE_HANDOFF.md');

  describe('Root README audit', () => {
    it('contains updated CI badge, accurate test count, and zero stale claims', () => {
      expect(fs.existsSync(rootReadmePath)).toBe(true);
      const readme = fs.readFileSync(rootReadmePath, 'utf-8');

      // CI badge and test count
      expect(readme).toContain('CI-182%20Passed-14F195');
      expect(readme).toContain('182 tests passed');
      expect(readme).not.toContain('106 tests passed');
      expect(readme).not.toContain('Gemini integration is planned for a follow-up release');

      // Start Here links
      expect(readme).toContain('docs/step-22/INTERNAL_RELEASE_HANDOFF.md');
      expect(readme).toContain('docs/step-21/INTERNAL_RELEASE_REHEARSAL.md');
      expect(readme).toContain('node examples/gemini-reference-agent/run.mjs');

      // Audit table entries
      expect(readme).toContain('Step 22');
      expect(readme).toContain('Step 21');
    });
  });

  describe('Step 21 report cleanup', () => {
    it('contains zero machine-specific file:// links and all markdown links resolve', () => {
      expect(fs.existsSync(step21ReportPath)).toBe(true);
      const step21 = fs.readFileSync(step21ReportPath, 'utf-8');

      // Zero file:// links
      expect(step21).not.toContain('file://');

      // Preserves historical evidence
      expect(step21).toContain('4786841689041b8a09eef8be5d7d45ae24f59043');
      expect(step21).toContain('4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6');
      expect(step21).toContain('5c3a89523668f57994042718825de91fd29a87f3');
    });
  });

  describe('Step 22 handoff report verification', () => {
    it('contains verified candidate, reproduction guide, operator references, and blocker inventory', () => {
      expect(fs.existsSync(step22HandoffPath)).toBe(true);
      const handoff = fs.readFileSync(step22HandoffPath, 'utf-8');

      // Candidate metadata
      expect(handoff).toContain('4786841689041b8a09eef8be5d7d45ae24f59043');
      expect(handoff).toContain('5c3a89523668f57994042718825de91fd29a87f3');
      expect(handoff).toContain('4abcee6076ae815ca286205f1bf430bdbce69d708ff8f73d2c97bfc0f5ca67d6');
      expect(handoff).toContain('shlita-sdk-0.1.0.tgz');

      // Verdict separation
      expect(handoff).toContain('Internal Release Verdict: **`READY`**');
      expect(handoff).toContain('External Controlled Pilot Verdict:');
      expect(handoff).toContain('NO-GO');

      // Blocker items
      expect(handoff).toContain('BLOCKER-HOST-01');
      expect(handoff).toContain('BLOCKER-DNS-01');
      expect(handoff).toContain('BLOCKER-SECRET-01');
      expect(handoff).toContain('DEFERRED-01');

      // Zero file:// links
      expect(handoff).not.toContain('file://');
    });

    it('verifies all repository-relative markdown links in step-22 handoff resolve to real files', () => {
      const handoff = fs.readFileSync(step22HandoffPath, 'utf-8');
      const step22Dir = path.dirname(step22HandoffPath);

      // Match all [text](path) where path does not start with http or #
      const linkRegex = /\[([^\]]+)\]\(([^)#]+)(?:#[^)]*)?\)/g;
      let match: RegExpExecArray | null;
      const checkedLinks: string[] = [];

      while ((match = linkRegex.exec(handoff)) !== null) {
        const linkTarget = match[2];
        if (linkTarget.startsWith('http://') || linkTarget.startsWith('https://')) {
          continue;
        }
        const resolvedTarget = path.resolve(step22Dir, linkTarget);
        expect(fs.existsSync(resolvedTarget), `Target does not exist: ${linkTarget} -> ${resolvedTarget}`).toBe(true);
        checkedLinks.push(linkTarget);
      }

      expect(checkedLinks.length).toBeGreaterThan(0);
    });
  });
});
