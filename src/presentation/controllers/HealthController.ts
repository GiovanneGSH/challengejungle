import { Controller, Get, Inject } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

@Controller('health')
export class HealthController {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  @Get('live')
  live() {
    return { status: 'UP', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready() {
    try {
      const conn = this.em.getConnection();
      await conn.execute('SELECT 1');
      return { status: 'READY', database: 'CONNECTED', timestamp: new Date().toISOString() };
    } catch {
      return { status: 'NOT_READY', database: 'DISCONNECTED', timestamp: new Date().toISOString() };
    }
  }
}