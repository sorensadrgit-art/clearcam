import test from 'node:test';
import assert from 'node:assert/strict';
import { followTransform, subjectBounds } from '../src/tracking/auto-frame.mjs';

test('follows a moving torso and reverses horizontal travel in a mirrored preview', () => {
  const bounds = { left: 0.15, right: 0.35, top: 0.35, bottom: 0.65, torsoPoints: 4 };
  assert.equal(followTransform(bounds, 1, 1, false), 'translate(50.00%, 0.00%) scale(2.000)');
  assert.equal(followTransform(bounds, 1, 2, true), 'translate(-25.00%, 0.00%) scale(2.000)');
  assert.equal(followTransform({ ...bounds, left: 0.65, right: 0.85 }, 1, 1, false),
    'translate(-50.00%, 0.00%) scale(2.000)');
});

test('ignores unreliable outliers and requires torso evidence to acquire a subject', () => {
  const points = [];
  points[11] = { x: 0.4, y: 0.3 };
  points[23] = { x: 0.45, y: 0.6, presence: 0.1 };
  points[27] = { x: 0.5, y: 0.8 };
  const bounds = subjectBounds(points, 0.55);
  assert.equal(bounds.torsoPoints, 1);
  assert.equal(followTransform(bounds, 1, 1, false), null);
  assert.equal(subjectBounds(null, 0.55), null);
});

test('keeps the full frame for a person already filling the view', () => {
  assert.equal(followTransform({ left: 0.1, right: 0.45, top: 0, bottom: 1, torsoPoints: 4 }, 1, 1, false),
    'translate(0.00%, 0.00%) scale(1.000)');
});
