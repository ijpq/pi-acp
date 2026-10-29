import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sharedSkillArgs } from '../../src/pi-rpc/shared-skills.js'

test('shared skills use native argv, canonical paths and no persistent copies', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-shared-skills-'))
  const skills = join(root, 'skills & templates')
  mkdirSync(skills)
  const alias = join(root, 'same-source')
  symlinkSync(skills, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.deepEqual(sharedSkillArgs(JSON.stringify([skills, alias]), root), ['--skill', realpathSync(skills)])
  assert.deepEqual(sharedSkillArgs(JSON.stringify(['skills & templates']), root), ['--skill', realpathSync(skills)])
  assert.deepEqual(sharedSkillArgs(undefined, root), [])
  assert.deepEqual(sharedSkillArgs(JSON.stringify([join(root, 'absent')]), root), [])
})

test('invalid shared skill contracts fail explicitly instead of silently ignoring configuration', () => {
  for (const value of [
    'not-json',
    '{}',
    '[null]',
    '[""]',
    '["bad\\u0000path"]',
    JSON.stringify(Array(65).fill('/source'))
  ]) {
    assert.throws(() => sharedSkillArgs(value, tmpdir()), /PI_SHARED_SKILL_CONFIG_INVALID/)
  }
})
