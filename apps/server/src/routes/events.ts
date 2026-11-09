import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventService } from '../events/service';

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  before: z.coerce.number().int().positive().optional(),
});

export function registerEventRoutes(api: FastifyInstance, events: EventService | undefined): void {
  // Historique public du flux (le direct passe par Socket.IO).
  api.get('/events', async (req, reply) => {
    const q = querySchema.parse(req.query);
    reply.header('Cache-Control', 'no-cache');
    return events ? events.recent(q.limit, q.before) : [];
  });
}
