'use strict';

// The feedback loop.
//
// The rules are guesses informed by convention. What makes them better is
// knowing which ones actually produced faster laps for THIS driver in THIS
// car -- which is the one asset a competitor cannot copy, and the reason the
// advice/feedback tables existed before the advisor did.

const crypto = require('node:crypto');

/** Record what the driver did with a piece of advice. */
async function recordFeedback(con, { adviceId, rating = null, applied = null, driverNote = null, resultLapId = null }) {
    const id = crypto.randomUUID();
    await con.run(
        `INSERT INTO feedback (feedback_id, advice_id, rating, applied, driver_note, result_lap_id, created_at)
         VALUES (?::UUID, ?::UUID, ?, ?, ?, ?::UUID, now())`,
        [id, adviceId, rating, applied, driverNote, resultLapId]
    );
    return id;
}

/**
 * Score every rule on its record.
 *
 * mean_delta_s is the honest one: the lap-time change between the lap the
 * advice was given on and the lap recorded as the result. NEGATIVE IS GOOD --
 * the lap got quicker. A rule that consistently fails to move it is a rule to
 * retire, however sensible it sounds.
 */
async function ruleScores(con) {
    const res = await con.runAndReadAll(`
        SELECT a.rule_id,
               count(*)                                              AS given,
               count(f.feedback_id)                                  AS answered,
               count(*) FILTER (WHERE f.applied)                     AS applied,
               avg(f.rating)                                         AS mean_rating,
               avg(rl.lap_time_s - al.lap_time_s)
                   FILTER (WHERE f.applied AND rl.lap_time_s IS NOT NULL
                                 AND al.lap_time_s IS NOT NULL)      AS mean_delta_s,
               count(*) FILTER (WHERE f.applied AND rl.lap_time_s < al.lap_time_s) AS improved
        FROM advice a
        LEFT JOIN feedback f ON f.advice_id = a.advice_id
        LEFT JOIN laps al ON al.lap_id = a.lap_id
        LEFT JOIN laps rl ON rl.lap_id = f.result_lap_id
        GROUP BY a.rule_id
        ORDER BY given DESC
    `);
    return res.getRowObjects().map((r) => ({
        rule_id: String(r.rule_id),
        given: Number(r.given),
        answered: Number(r.answered),
        applied: Number(r.applied),
        improved: Number(r.improved),
        meanRating: r.mean_rating == null ? null : Number(r.mean_rating),
        meanDeltaS: r.mean_delta_s == null ? null : Number(r.mean_delta_s),
    }));
}

function renderScores(scores) {
    const L = ['RULE SCORECARD  (mean delta: negative = laps got quicker)', '-'.repeat(78)];
    L.push('  rule                            given  applied  improved  mean delta  rating');
    for (const s of scores) {
        L.push(
            `  ${s.rule_id.padEnd(30)} ${String(s.given).padStart(5)} ` +
            `${String(s.applied).padStart(8)} ${String(s.improved).padStart(9)} ` +
            `${(s.meanDeltaS == null ? '-' : s.meanDeltaS.toFixed(3) + 's').padStart(11)} ` +
            `${(s.meanRating == null ? '-' : s.meanRating.toFixed(2)).padStart(7)}`
        );
    }
    return L.join('\n');
}

module.exports = { recordFeedback, ruleScores, renderScores };
