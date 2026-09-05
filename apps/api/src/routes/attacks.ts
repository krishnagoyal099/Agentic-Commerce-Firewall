// apps/api/src/routes/attacks.ts
import type { FastifyInstance } from 'fastify';
import { ATTACKS, type AttackName, type AttackReport } from '@acsf/shared';
import type { AppContext } from '../appContext';
import { DomainError } from '../utils/errors';

export function registerAttackRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/attacks/:attackName', async (request): Promise<AttackReport> => {
    const { attackName } = request.params as { attackName: string };
    if (!(ATTACKS as readonly string[]).includes(attackName)) {
      throw new DomainError('UNKNOWN_ATTACK', `Unknown attack "${attackName}". Available: ${ATTACKS.join(', ')}.`);
    }
    return ctx.attackService.run(attackName as AttackName);
  });
}