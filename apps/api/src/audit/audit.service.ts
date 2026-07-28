import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) { }

  async log(
    orgId: string,
    actorId: string | null,
    action: string,
    resourceType: string,
    resourceId: string,
    before: any,
    after: any,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    // Async fire-and-forget - audit failures must never block the main operation
    this.prisma.auditLog
      .create({
        data: {
          orgId,
          actorId: actorId || undefined,
          actorEmail: '',
          action,
          resourceType,
          resourceId,
          diffJson: { before, after },
          ipAddress: meta?.ipAddress || '',
          userAgent: meta?.userAgent || '',
        },
      })
      .catch((err) => console.error('[AuditService] Failed to write log:', err));
  }

  async query(orgId: string, filters: {
    resourceType?: string;
    resourceId?: string;
    actorId?: string;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }) {
    const where: any = { orgId };
    if (filters.resourceType) where.resourceType = filters.resourceType;
    if (filters.resourceId) where.resourceId = filters.resourceId;
    if (filters.actorId) where.actorId = filters.actorId;
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = filters.from;
      if (filters.to) where.createdAt.lte = filters.to;
    }

    const page = filters.page || 1;
    const limit = filters.limit || 50;

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
