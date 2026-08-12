import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreateTruckInput,
  MasterDataListQuery,
  Page,
  RemovalResult,
  Truck,
  UpdateTruckInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, dateToIso, decimalToString } from './serialize';

type TruckRow = Prisma.TruckGetPayload<Record<string, never>>;

@Injectable()
export class TrucksService {
  constructor(private readonly prisma: PrismaService) {}

  private get trucks() {
    return this.prisma.client.truck;
  }

  async list(query: MasterDataListQuery): Promise<Page<Truck>> {
    const where: Prisma.TruckWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { plateNumber: { contains: query.search, mode: 'insensitive' } },
              { make: { contains: query.search, mode: 'insensitive' } },
              { model: { contains: query.search, mode: 'insensitive' } },
              { bodyType: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // The soft-delete extension adds `deletedAt: null` to both of these, so
    // neither the page nor the count can disagree about what exists.
    const [rows, total] = await Promise.all([
      this.trucks.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { plateNumber: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.trucks.count({ where }),
    ]);

    return {
      items: rows.map(toTruck),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<Truck> {
    const row = await this.trucks.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No truck with id ${id}`);
    }

    return toTruck(row);
  }

  async create(input: CreateTruckInput): Promise<Truck> {
    // createdBy is stamped by the audit extension from the ambient actor and
    // is deliberately absent here — see withActor().
    const row = await this.trucks.create({
      data: {
        plateNumber: input.plateNumber,
        make: input.make,
        model: input.model,
        modelYear: input.modelYear,
        bodyType: input.bodyType,
        capacityKg: input.capacityKg,
        registrationExpiry: input.registrationExpiry,
        isActive: input.isActive,
      },
    });

    return toTruck(row);
  }

  async update(id: string, input: UpdateTruckInput): Promise<Truck> {
    await this.get(id);

    const row = await this.trucks.update({
      where: { id },
      data: input,
    });

    return toTruck(row);
  }

  /**
   * Trucks are never hard-deleted: a truck that has hauled anything is part of
   * the record of that trip. Unreferenced ones soft-delete; referenced ones
   * deactivate, which is the state a sold truck should be in anyway.
   */
  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [
        {
          entity: 'shipments',
          count: () => this.prisma.client.shipment.count({ where: { truckId: id } }),
        },
      ],
      deactivate: () => this.trucks.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.trucks.softDelete({ id }),
    });
  }
}

function toTruck(row: TruckRow): Truck {
  return {
    id: row.id,
    plateNumber: row.plateNumber,
    make: row.make,
    model: row.model,
    modelYear: row.modelYear,
    bodyType: row.bodyType,
    capacityKg: decimalToString(row.capacityKg),
    registrationExpiry: dateToIso(row.registrationExpiry),
    isActive: row.isActive,
    ...auditFields(row),
  };
}
