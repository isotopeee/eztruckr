import { Controller, ForbiddenException, Get, Param, Query } from '@nestjs/common';
import {
  FORMULA_FIELD_CATALOG,
  UserRole,
  type Commission,
  type RuleCoverageReport,
} from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import { CAN_READ_SHIPMENTS, CAN_WRITE_SHIPMENT_MONEY } from '../auth/role-policy';
import { RuleCoverageQueryDto } from '../shipments/shipments.dto';
import { CommissionCoverageService } from './commission-coverage.service';
import { CommissionService } from './commission.service';

@Controller('commissions')
export class CommissionController {
  constructor(
    private readonly commissions: CommissionService,
    private readonly coverage: CommissionCoverageService,
  ) {}

  /**
   * The field catalog a FORMULA rule may reference.
   *
   * Served rather than duplicated in the web app so the authoring screen can
   * only ever offer fields the evaluator actually resolves, and so the
   * double-counting warnings travel with them.
   */
  @Get('formula-fields')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  formulaFields(): { fields: Array<{ name: string; description: string }> } {
    return {
      fields: Object.entries(FORMULA_FIELD_CATALOG).map(([name, description]) => ({
        name,
        description,
      })),
    };
  }

  /**
   * Whether the rules needed to pay future shipments actually exist.
   *
   * A warning, never a block. It exists because removing the fallback rates
   * turned a quietly wrong number into a hard failure, and a hard failure
   * wants to be found before it lands on a real payout.
   */
  @Get('rule-coverage')
  @Roles(...CAN_READ_SHIPMENTS)
  ruleCoverage(@Query() query: RuleCoverageQueryDto): Promise<RuleCoverageReport> {
    return this.coverage.report(query.horizonDays);
  }

  /**
   * Everything owed to one crew member.
   *
   * A crew session may only ask about itself, checked against the session's
   * own `crewMemberId` rather than anything in the request.
   */
  @Get('crew/:crewMemberId')
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  listForCrew(
    @Param('crewMemberId') crewMemberId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Commission[]> {
    if (user.role === UserRole.CREW && user.crewMemberId !== crewMemberId) {
      throw new ForbiddenException('You can only view your own commissions.');
    }

    return this.commissions.listForCrewMember(crewMemberId);
  }
}
