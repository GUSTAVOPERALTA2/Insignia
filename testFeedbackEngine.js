// testFeedbackEngine.js
// Mini test runner para coreFeedbackEngine usando los casos en tests/feedbackEngineCases.json

const path = require('path');
const fs = require('fs');

const { runFeedbackEngine } = require('./modules/ai/coreFeedbackEngine');

function loadCases() {
  const filePath = path.join(__dirname, 'tests', 'feedbackEngineCases.json');
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function color(text, code) {
  return `\x1b[${code}m${text}\x1b[0m`;
}
const green = (t) => color(t, '32');
const red   = (t) => color(t, '31');
const yellow= (t) => color(t, '33');

async function run() {
  const cases = loadCases();
  let passed = 0;
  let failed = 0;

  for (const c of cases) {
    const { id, description, input, expected } = c;
    const { text, roleHint, ticket } = input;

    try {
      const result = await runFeedbackEngine({
        text,
        roleHint,
        ticket,
        history: [],
        source: 'test_case'
      });

      const mismatches = [];

      // next_status
      if (expected.next_status !== undefined) {
        const got = result.next_status || null;
        if (got !== expected.next_status) {
          mismatches.push(`next_status: expected "${expected.next_status}", got "${got}"`);
        }
      }

      // is_relevant, si lo definimos en el caso
      if (expected.is_relevant !== undefined) {
        if (result.is_relevant !== expected.is_relevant) {
          mismatches.push(`is_relevant: expected ${expected.is_relevant}, got ${result.is_relevant}`);
        }
      }

      // requester_side, si aplica
      if (expected.requester_side !== undefined) {
        const got = result.requester_side || null;
        if (got !== expected.requester_side) {
          mismatches.push(`requester_side: expected "${expected.requester_side}", got "${got}"`);
        }
      }

      if (mismatches.length === 0) {
        passed++;
        console.log(
          green(`[OK] ${id}`),
          `- ${description}`,
          `→ next_status=${result.next_status} (conf=${result.confidence?.toFixed?.(2) ?? 'n/a'})`
        );
      } else {
        failed++;
        console.log(
          red(`[FAIL] ${id}`),
          `- ${description}`
        );
        mismatches.forEach(m => console.log('   ', yellow('-'), m));
        console.log('   result snapshot:', {
          is_relevant: result.is_relevant,
          role: result.role,
          status_intent: result.status_intent,
          requester_side: result.requester_side,
          next_status: result.next_status,
          confidence: result.confidence
        });
      }
    } catch (e) {
      failed++;
      console.log(
        red(`[ERROR] ${c.id}`),
        `- ${description}: ${e.message || e}`
      );
    }
  }

  console.log('\nResumen:');
  console.log('  ', green(`Pasaron: ${passed}`));
  console.log('  ', failed ? red(`Fallaron/errores: ${failed}`) : green('Fallaron/errores: 0'));
}

run();
