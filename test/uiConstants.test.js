import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DONUT_CIRCUMFERENCE,
  AUTO_COLLAPSE_THRESHOLD,
  GHOST_OPACITY,
  HOVER_LINE_COLOR,
  COPY_FEEDBACK_MS,
  MIN_B_PREVIEW,
  OTHERS_DRIFT_WARN_PCT,
  MAG_VISIBLE_TICKS as UI_MAG_VISIBLE_TICKS,
  CHURN_ELEVATED_THRESHOLD as UI_CHURN_ELEVATED_THRESHOLD,
  CHURN_STRUGGLING_THRESHOLD as UI_CHURN_STRUGGLING_THRESHOLD,
  CHURN_STRUGGLING_REREADS as UI_CHURN_STRUGGLING_REREADS,
  WASTE_FLOOR as UI_WASTE_FLOOR,
} from '../public/lib/uiConstants.js';

import {
  MAG_VISIBLE_TICKS,
  CHURN_ELEVATED_THRESHOLD,
  CHURN_STRUGGLING_THRESHOLD,
  CHURN_STRUGGLING_REREADS,
  WASTE_FLOOR,
} from '../lib/constants.js';

describe('uiConstants', () => {
  it('DONUT_CIRCUMFERENCE is a number equal to 88', () => {
    assert.equal(typeof DONUT_CIRCUMFERENCE, 'number');
    assert.equal(DONUT_CIRCUMFERENCE, 88);
  });

  it('AUTO_COLLAPSE_THRESHOLD is a number equal to 5', () => {
    assert.equal(typeof AUTO_COLLAPSE_THRESHOLD, 'number');
    assert.equal(AUTO_COLLAPSE_THRESHOLD, 5);
  });

  it('GHOST_OPACITY is a number equal to 0.3', () => {
    assert.equal(typeof GHOST_OPACITY, 'number');
    assert.equal(GHOST_OPACITY, 0.3);
  });

  it('HOVER_LINE_COLOR is a string equal to "#6cc6f0"', () => {
    assert.equal(typeof HOVER_LINE_COLOR, 'string');
    assert.equal(HOVER_LINE_COLOR, '#6cc6f0');
  });

  it('COPY_FEEDBACK_MS is a number equal to 1500', () => {
    assert.equal(typeof COPY_FEEDBACK_MS, 'number');
    assert.equal(COPY_FEEDBACK_MS, 1500);
  });

  it('MIN_B_PREVIEW is a number equal to 1000', () => {
    assert.equal(typeof MIN_B_PREVIEW, 'number');
    assert.equal(MIN_B_PREVIEW, 1000);
  });

  it('OTHERS_DRIFT_WARN_PCT is a number equal to 0.02', () => {
    assert.equal(typeof OTHERS_DRIFT_WARN_PCT, 'number');
    assert.equal(OTHERS_DRIFT_WARN_PCT, 0.02);
  });
});

describe('uiConstants parity with lib/constants', () => {
  it('MAG_VISIBLE_TICKS matches lib/constants', () => {
    assert.equal(UI_MAG_VISIBLE_TICKS, MAG_VISIBLE_TICKS);
  });

  it('CHURN_ELEVATED_THRESHOLD matches lib/constants', () => {
    assert.equal(UI_CHURN_ELEVATED_THRESHOLD, CHURN_ELEVATED_THRESHOLD);
  });

  it('CHURN_STRUGGLING_THRESHOLD matches lib/constants', () => {
    assert.equal(UI_CHURN_STRUGGLING_THRESHOLD, CHURN_STRUGGLING_THRESHOLD);
  });

  it('CHURN_STRUGGLING_REREADS matches lib/constants', () => {
    assert.equal(UI_CHURN_STRUGGLING_REREADS, CHURN_STRUGGLING_REREADS);
  });

  it('WASTE_FLOOR matches lib/constants', () => {
    assert.equal(UI_WASTE_FLOOR, WASTE_FLOOR);
  });
});
