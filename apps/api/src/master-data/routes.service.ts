import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreateRouteInput,
  MasterDataListQuery,
  Page,
  RemovalResult,
  Route,
  UpdateRouteInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, decimalToString } from './serialize';

type RouteRow = Prisma.RouteGetPayload<Record<string, never>>;

@Injectable()
export class RoutesService {
  constructor(private readonly prisma: PrismaService) {}

  private get routes() {
    return this.prisma.client.route;
  }

  async list(query: MasterDataListQuery): Promise<Page<Route>> {
    const where: Prisma.RouteWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { origin: { contains: query.search, mode: 'insensitive' } },
              { destination: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.routes.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.routes.count({ where }),
    ]);

    return { items: rows.map(toRoute), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<Route> {
    const row = await this.routes.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No route with id ${id}`);
    }

    return toRoute(row);
  }

  async create(input: CreateRouteInput): Promise<Route> {
    return toRoute(await this.routes.create({ data: { ...input } }));
  }

  async update(id: string, input: UpdateRouteInput): Promise<Route> {
    await this.get(id);
    return toRoute(await this.routes.update({ where: { id }, data: input }));
  }

  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [
        {
          entity: 'shipments',
          count: () => this.prisma.client.shipment.count({ where: { routeId: id } }),
        },
        {
          entity: 'commission rules',
          count: () => this.prisma.client.commissionRule.count({ where: { routeId: id } }),
        },
      ],
      deactivate: () => this.routes.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.routes.softDelete({ id }),
    });
  }
}

function toRoute(row: RouteRow): Route {
  return {
    id: row.id,
    name: row.name,
    origin: row.origin,
    destination: row.destination,
    distanceKm: decimalToString(row.distanceKm),
    standardRate: decimalToString(row.standardRate),
    standardAllowance: decimalToString(row.standardAllowance),
    isActive: row.isActive,
    ...auditFields(row),
  };
}
