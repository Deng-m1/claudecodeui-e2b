/**
 * Unified messages endpoint.
 *
 * GET /api/sessions/:sessionId/messages?provider=claude&projectName=foo&limit=50&offset=0
 *
 * Replaces the four provider-specific session message endpoints with a single route
 * that delegates to the appropriate adapter via the provider registry.
 *
 * @module routes/messages
 */

import express from 'express';
import { getProvider, getAllProviders } from '../providers/registry.js';
import { getSessionBootstrap } from '../projects.js';
import { fetchSessionHistory } from '../services/session-history/store.js';

const router = express.Router();

router.get('/:sessionId/bootstrap', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const bootstrap = await getSessionBootstrap(sessionId, {
      userId: req.user?.id || null,
    });

    if (!bootstrap) {
      return res.status(404).json({ error: 'Session not found' });
    }

    return res.json(bootstrap);
  } catch (error) {
    console.error('Error fetching session bootstrap:', error);
    return res.status(500).json({ error: 'Failed to fetch session bootstrap' });
  }
});

/**
 * GET /api/sessions/:sessionId/messages
 *
 * Auth: authenticateToken applied at mount level in index.js
 *
 * Query params:
 *   provider       - 'claude' | 'cursor' | 'codex' | 'gemini' | 'e2b' (default: 'claude')
 *   projectName    - required for claude provider
 *   projectPath    - required for cursor provider (absolute path used for cwdId hash)
 *   limit          - page size
 *   offset         - legacy pagination offset (default: 0)
 *   mode           - 'bootstrap' | 'before' | 'delta' | omitted(legacy)
 *   beforeSeq      - used with mode=before
 *   afterSeq       - used with mode=delta
 *   sessionVersion - used with mode=delta
 */
router.get('/:sessionId/messages', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const provider = req.query.provider || 'claude';
    const projectName = req.query.projectName || '';
    const projectPath = req.query.projectPath || '';

    const adapter = getProvider(provider);
    if (!adapter) {
      const available = getAllProviders().join(', ');
      return res.status(400).json({ error: `Unknown provider: ${provider}. Available: ${available}` });
    }

    const result = await fetchSessionHistory(
      sessionId,
      {
        provider: typeof provider === 'string' ? provider : 'claude',
        projectName: typeof projectName === 'string' ? projectName : '',
        projectPath: typeof projectPath === 'string' ? projectPath : '',
      },
      req.query,
    );

    return res.json(result);
  } catch (error) {
    console.error('Error fetching unified messages:', error);
    return res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

export default router;
