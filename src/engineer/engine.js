'use strict';

// Runs the rule set and persists what it found.
//
// Two things here matter as much as the rules themselves:
//
// 1. EXIT PRIORITY. A corner feeding a long straight is worth more than one
//    that feeds another corner, because exit speed is carried all the way
//    down the following straight. Engineers weight their attention that way
//    and so does this -- findings on high-priority corners get promoted.
//
// 2. RESTRAINT. An engineer who says sixteen things has said nothing. Output
//    is ranked and capped, so what comes back is what to work on next.

const crypto = require('node:crypto');
const { RULES, THRESHOLDS } = require('./rules');
const A = require('../analysis/compare');

const SEVERITY_RANK = { strong: 3, suggest: 2, info: 1 };

/** Gather everything the rules read. */
async function buildContext(con, { track, lapId, referenceLapId, lapIds }) {
    const [mine, deltas, technique, balance, tyres, priority, segments] = await Promise.all([
        A.cornerMetrics(con, { track, lapId }),
        referenceLapId ? A.segmentDeltas(con, { track, lapA: lapId, lapB: referenceLapId }) : [],
        A.cornerTechnique(con, { track, lapId }),
        A.tyreBalance(con, { lapId }),
        A.tyreProfile(con, { lapId }),
        A.exitPriority(con, { track }),
        (await con.runAndReadAll(
            `SELECT seg_num, kind, start_m, apex_m, end_m, min_speed_ms, entry_speed_ms
             FROM track_segments WHERE track = ? ORDER BY seg_num`, [track])).getRowObjects(),
    ]);

    const ref = referenceLapId ? await A.cornerMetrics(con, { track, lapId: referenceLapId }) : [];
    const consistency = lapIds && lapIds.length >= 3
        ? await A.consistency(con, { track, lapIds })
        : null;

    // Heavy braking zones, biggest speed drop first -- where lifting is cheap.
    const liftCandidates = segments
        .filter((s) => String(s.kind) === 'corner' && s.entry_speed_ms != null)
        .map((s) => ({
            seg_num: Number(s.seg_num),
            entry_speed_ms: Number(s.entry_speed_ms),
            min_speed_ms: Number(s.min_speed_ms),
            speed_drop_ms: Number(s.entry_speed_ms) - Number(s.min_speed_ms),
        }))
        .sort((a, b) => b.speed_drop_ms - a.speed_drop_ms);

    return { track, lapId, referenceLapId, mine, ref, deltas, technique, balance, tyres, consistency, priority, liftCandidates };
}

/**
 * Evaluate every rule, weight by exit priority, rank, and cap.
 * Returns findings without writing them; `analyse` persists.
 */
function evaluate(ctx, { thresholds = THRESHOLDS, limit = 6 } = {}) {
    const findings = [];

    for (const rule of RULES) {
        let produced;
        try {
            produced = rule.evaluate(ctx, thresholds) ?? [];
        } catch (e) {
            // One broken rule must not take the engineer down.
            findings.push({
                rule_id: rule.id, seg_num: null, severity: 'info',
                title: `Rule ${rule.id} failed`, detail: e.message, evidence: { error: e.message },
                _failed: true,
            });
            continue;
        }
        for (const f of produced) findings.push({ rule_id: rule.id, ...f });
    }

    // Exit priority: promote findings on corners that feed a long straight.
    const priorities = [...(ctx.priority?.values() ?? [])];
    const maxStraight = priorities.length ? Math.max(...priorities) : 0;
    for (const f of findings) {
        const straightM = f.seg_num == null ? 0 : (ctx.priority?.get(f.seg_num) ?? 0);
        f.exit_priority = maxStraight > 0 ? straightM / maxStraight : 0;
        if (f.exit_priority >= 0.7 && f.severity === 'suggest') {
            f.severity = 'strong';
            f.detail += ` This corner feeds a ${Math.round(straightM)}m straight, so exit speed here is ` +
                `carried the whole way down it — worth more than the raw time delta suggests.`;
        }
    }

    const lostFor = (seg) => (ctx.deltas ?? []).find((d) => d.seg_num === seg)?.lost_s ?? 0;
    findings.sort((a, b) =>
        (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) ||
        (lostFor(b.seg_num) - lostFor(a.seg_num)) ||
        (b.exit_priority - a.exit_priority)
    );

    return findings.slice(0, limit);
}

/** Evaluate and write the findings to the advice table. */
async function analyse(con, opts) {
    const ctx = await buildContext(con, opts);
    const findings = evaluate(ctx, opts);

    const stored = [];
    for (const f of findings) {
        const id = crypto.randomUUID();
        await con.run(
            `INSERT INTO advice (advice_id, lap_id, rule_id, severity, title, detail, evidence, created_at)
             VALUES (?::UUID, ?::UUID, ?, ?, ?, ?, ?::JSON, now())`,
            [id, opts.lapId, f.rule_id, f.severity, f.title, f.detail,
             JSON.stringify({ ...f.evidence, seg_num: f.seg_num })]
        );
        stored.push({ advice_id: id, ...f });
    }
    return { context: ctx, findings: stored };
}

function render(findings) {
    if (findings.length === 0) return 'Nothing worth saying — the lap is clean on every rule.';
    const mark = { strong: '!!', suggest: ' !', info: '  ' };
    const L = ['ENGINEER', '='.repeat(72)];
    for (const f of findings) {
        const where = f.seg_num == null ? 'car' : `seg ${f.seg_num}`;
        L.push(`${mark[f.severity]} [${where}] ${f.title}`);
        L.push(`     ${f.detail.replace(/\s+/g, ' ')}`);
        L.push('');
    }
    return L.join('\n');
}

module.exports = { buildContext, evaluate, analyse, render, SEVERITY_RANK };
