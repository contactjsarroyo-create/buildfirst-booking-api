import { sql } from '@vercel/postgres';
import { expireFiles } from './_lib/storage.js';

export default async function handler(req, res) {
  // Daily storage cleanup, triggered by the cron in vercel.json. Merged into
  // this file (not a new route) because of the 12-function Hobby cap.
  // Vercel sends "Authorization: Bearer <CRON_SECRET>" on cron calls, so
  // nobody else can trigger it.
  if (req.query && req.query.resource === 'cleanup') {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    try {
      const result = await expireFiles();
      return res.status(200).json({ ok: true, ...result });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false, error: 'Cleanup failed' });
    }
  }

  try {
    const result = await sql`SELECT NOW()`;
    res.status(200).json({ ok: true, time: result.rows[0] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
