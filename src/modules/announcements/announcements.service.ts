import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import { Announcement, AnnouncementDocument } from './schemas/announcement.schema';
import {
  AnnouncementDelivery,
  AnnouncementDeliveryDocument,
} from './schemas/announcement-delivery.schema';
import { AnnouncementFanoutQueueService } from './queues/announcement-fanout.queue';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { User, UserDocument } from '../users/schemas/user.schema';
import { Company, CompanyDocument } from '../companies/schemas/company.schema';
import { UserRole } from '../../common/enums/user-role.enum';
import { CompanyStatus } from '../../common/enums/company-status.enum';
import { AnnouncementState } from '../../common/enums/announcement-state.enum';
import { AnnouncementDeliveryFailureReason } from '../../common/enums/announcement-delivery-failure-reason.enum';
import { TenantContextService } from '../../common/context/tenant-context.service';
import { paginate, PaginatedResponse } from '../../common/pagination/paginate.util';
import { CursorSortField } from '../../common/pagination/cursor.util';

const ANNOUNCEMENT_SORT_KEYS: CursorSortField[] = [
  { field: 'createdAt', direction: 'desc' },
  { field: '_id', direction: 'desc' },
];

/**
 * The roles an announcement reaches (FR-051).
 *
 * **`CLIENT` and `DRIVER` are never recipients**, and this is a named constant
 * rather than an inline array so the resolution query and the test that asserts
 * it by ROLE (never by count) read the same list. An announcement is
 * administrative: it is addressed to the people who run the companies on the
 * platform, not to the people who buy or deliver fuel.
 */
export const ANNOUNCEMENT_RECIPIENT_ROLES: readonly UserRole[] = [
  UserRole.FUEL_COMPANY_ADMIN,
  UserRole.TRANSPORT_COMPANY_ADMIN,
] as const;

/**
 * One person (or one administrator-less company) an announcement was resolved
 * against, and whether it can reach them.
 *
 * `failureReason` present means unreachable — recorded as missed, never counted
 * as delivered. `recipient` absent happens only for `NO_ACTIVE_ADMIN`, where
 * there is no person to name.
 */
export interface AnnouncementCandidate {
  companyId: Types.ObjectId;
  recipient?: UserDocument;
  failureReason?: AnnouncementDeliveryFailureReason;
}

@Injectable()
export class AnnouncementsService {
  constructor(
    @InjectModel(Announcement.name)
    private readonly announcementModel: Model<AnnouncementDocument>,
    @InjectModel(AnnouncementDelivery.name)
    private readonly deliveryModel: Model<AnnouncementDeliveryDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Company.name) private readonly companyModel: Model<CompanyDocument>,
    private readonly fanoutQueue: AnnouncementFanoutQueueService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * FR-048/FR-055 — creates the announcement, resolves who it is intended for,
   * and ENQUEUES the fan-out. It does not perform it.
   *
   * The recipient count is resolved here rather than in the worker so the
   * `202` can state it: an operator who sends to "every company" and gets back
   * a number can tell immediately whether it matches the platform they think
   * they have. Resolving it in the worker would leave the response with nothing
   * to say.
   */
  async create(
    dto: CreateAnnouncementDto,
    sentBy: string,
  ): Promise<{ announcementId: string; intendedRecipientCount: number; state: AnnouncementState }> {
    const targetCompanyIds = (dto.targetCompanyIds ?? []).map((id) => new Types.ObjectId(id));
    const recipients = await this.resolveRecipients(targetCompanyIds);

    const announcement = await this.announcementModel.create({
      title: dto.title,
      body: dto.body,
      sentBy: new Types.ObjectId(sentBy),
      targetCompanyIds,
      intendedRecipientCount: recipients.length,
      state: AnnouncementState.QUEUED,
    });

    const announcementId = String(announcement._id);
    await this.fanoutQueue.enqueue(announcementId);

    return {
      announcementId,
      intendedRecipientCount: recipients.length,
      state: AnnouncementState.QUEUED,
    };
  }

  /**
   * FR-049/FR-050/FR-051/FR-054 — every candidate for one announcement, each
   * marked reachable or not, **with a named reason when not**.
   *
   * Deliberately NOT a query that filters the unreachable away. If a suspended
   * company's administrators simply never appeared, the operator would be told
   * nothing about them — and "this company received nothing because it is
   * suspended" is exactly what FR-054 exists to surface. The filtering happens
   * here, in the open, where each exclusion produces a reason.
   *
   * Runs unscoped: the operator has no tenant of their own, and this has to
   * reach across every company on the platform. A `SUPER_ADMIN` request
   * context already takes the plugins' bypass, but this is also called from the
   * WORKER, where there is no context at all — so the bypass is stated rather
   * than inherited from whoever happens to be calling.
   */
  async resolveCandidates(targetCompanyIds: Types.ObjectId[]): Promise<AnnouncementCandidate[]> {
    return this.tenantContext.runUnscoped(async () => {
      const companyFilter: FilterQuery<CompanyDocument> = {};
      // An EMPTY target list means every company (FR-049). That is the whole
      // meaning of the field — see the schema's note on why there is no
      // `targetsAllCompanies` boolean beside it.
      if (targetCompanyIds.length > 0) {
        companyFilter._id = { $in: targetCompanyIds };
      }
      const companies = await this.companyModel
        .find(companyFilter)
        .select({ _id: 1, status: 1 })
        .exec();
      if (companies.length === 0) return [];

      const admins = await this.userModel
        .find({
          companyId: { $in: companies.map((c) => c._id) },
          role: { $in: ANNOUNCEMENT_RECIPIENT_ROLES as UserRole[] },
        })
        .exec();

      const adminsByCompany = new Map<string, UserDocument[]>();
      for (const admin of admins) {
        const key = String(admin.companyId);
        adminsByCompany.set(key, [...(adminsByCompany.get(key) ?? []), admin]);
      }

      const candidates: AnnouncementCandidate[] = [];
      for (const company of companies) {
        const companyId = company._id as Types.ObjectId;
        const companyAdmins = adminsByCompany.get(String(companyId)) ?? [];

        if (company.status !== CompanyStatus.ACTIVE) {
          // Recorded per administrator, so an operator reading the failures
          // sees who did not get it, not merely that somebody did not.
          for (const admin of companyAdmins) {
            candidates.push({
              companyId,
              recipient: admin,
              failureReason: AnnouncementDeliveryFailureReason.COMPANY_SUSPENDED,
            });
          }
          if (companyAdmins.length === 0) {
            candidates.push({
              companyId,
              failureReason: AnnouncementDeliveryFailureReason.NO_ACTIVE_ADMIN,
            });
          }
          continue;
        }

        const activeAdmins = companyAdmins.filter((admin) => admin.isActive);
        if (activeAdmins.length === 0) {
          // No person to address at all — recorded against the company.
          candidates.push({
            companyId,
            failureReason: AnnouncementDeliveryFailureReason.NO_ACTIVE_ADMIN,
          });
        }
        for (const admin of companyAdmins) {
          candidates.push({
            companyId,
            recipient: admin,
            failureReason: admin.isActive
              ? undefined
              : AnnouncementDeliveryFailureReason.ADMIN_DEACTIVATED,
          });
        }
      }
      return candidates;
    });
  }

  /**
   * The candidates an announcement is actually INTENDED for — the reachable
   * ones. This is the figure the `202` states, so an operator who sends to
   * "every company" can tell at a glance whether it matches the platform they
   * believe they have.
   */
  async resolveRecipients(targetCompanyIds: Types.ObjectId[]): Promise<UserDocument[]> {
    const candidates = await this.resolveCandidates(targetCompanyIds);
    return candidates.filter((c) => !c.failureReason && c.recipient).map((c) => c.recipient!);
  }

  /** FR-052 — what was sent, newest first. Distinct from the deliveries. */
  list(cursor?: string): Promise<PaginatedResponse<AnnouncementDocument>> {
    return paginate(this.announcementModel, {}, ANNOUNCEMENT_SORT_KEYS, cursor);
  }

  /**
   * FR-052/FR-054 — one announcement with its tallies and the rows that
   * failed.
   *
   * Only the FAILED deliveries are returned in full. The successful ones are a
   * count: an operator reading this is asking "did it land, and who missed it",
   * and listing every successful delivery would bury that answer under N rows
   * saying nothing.
   */
  async findOne(id: string): Promise<{
    announcement: AnnouncementDocument;
    failures: AnnouncementDeliveryDocument[];
  }> {
    const announcement = await this.announcementModel.findById(id).exec();
    if (!announcement) {
      throw new NotFoundException('Announcement not found');
    }
    const failures = await this.deliveryModel
      .find({ announcementId: announcement._id, failureReason: { $exists: true } })
      .exec();
    return { announcement, failures };
  }
}
