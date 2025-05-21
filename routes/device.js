import express from 'express';
import { insertEntry, getLatestEntry, sseUpdates } from '../controllers/device.js';

const router = express.Router();

router.post('/', insertEntry);
router.get('/latest-entry', getLatestEntry);
router.get('/updates', sseUpdates);

export default router;