import { and, eq } from 'drizzle-orm';
import type { GuildMember } from 'discord.js';
import type { Db } from '../db/database.js';
import { globalBans } from '../db/schema.js';
import type { ConfigStore } from './configStore.js';
import type { FairQueue } from '../queues/fairQueue.js';

export class GlobalBanService {
  constructor(
    private readonly db: Db,
    private readonly configStore: ConfigStore,
    private readonly moderationQueue: FairQueue,
  ) {}

  async handleJoin(member: GuildMember) {
    const config = await this.configStore.getGuildConfig(member.guild.id);
    if (!config.globalBansEnabled) return;

    const ban = await this.db.select().from(globalBans).where(and(eq(globalBans.userId, member.id), eq(globalBans.status, 'active'))).get();
    if (!ban) return;

    await this.moderationQueue.enqueue(member.guild.id, () => member.guild.members.ban(member.id, { reason: `Honeybot global ban: ${ban.reason}` }));
  }
}
