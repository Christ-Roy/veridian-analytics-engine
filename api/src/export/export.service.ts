import { Injectable, BadRequestException } from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import {
  UserEventsQueryDto,
  UserEventRow,
  UserEventsResponse,
} from './dto/user-events-query.dto';

interface CursorData {
  updated_at: string;
  id: string;
}

@Injectable()
export class ExportService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly workspacesService: WorkspacesService,
  ) {}

  async getUserEvents(dto: UserEventsQueryDto): Promise<UserEventsResponse> {
    // Validate workspace exists
    await this.workspacesService.get(dto.workspace_id);

    // Require either cursor or since to prevent full table scan
    if (!dto.cursor && !dto.since) {
      throw new BadRequestException(
        'Either cursor or since parameter is required',
      );
    }

    const limit = dto.limit ?? 100;
    const params: Record<string, unknown> = {};
    let cursorData: CursorData | null = null;

    // Parse cursor if provided
    if (dto.cursor) {
      try {
        const decoded = Buffer.from(dto.cursor, 'base64').toString();
        cursorData = JSON.parse(decoded) as CursorData;
        if (!cursorData.updated_at || !cursorData.id) {
          throw new Error('Invalid cursor structure');
        }
      } catch {
        throw new BadRequestException('Invalid cursor format');
      }
    }

    // Build WHERE conditions. Columns are prefixed `e.` because the events table
    // is now LEFT JOINed with user_attribution (`ua`), which shares column names
    // (user_id, updated_at) — unqualified refs would be ambiguous.
    const conditions: string[] = ['e.user_id IS NOT NULL'];

    if (cursorData) {
      // Cursor-based pagination (timestamp ties use id as tiebreaker)
      conditions.push(
        '(e.updated_at, e.id) > ({cursor_updated_at:String}, {cursor_id:String})',
      );
      params.cursor_updated_at = cursorData.updated_at;
      params.cursor_id = cursorData.id;
    } else if (dto.since) {
      // Initial query with since timestamp
      const sinceDate = new Date(dto.since);
      const sinceClickhouse = this.toClickHouseDateTime(sinceDate);
      conditions.push('e.updated_at >= {since:String}');
      params.since = sinceClickhouse;
    }

    // Add until constraint (always applied, even with cursor)
    const untilDate = new Date(dto.until);
    const untilClickhouse = this.toClickHouseDateTime(untilDate);
    conditions.push('e.updated_at <= {until:String}');
    params.until = untilClickhouse;

    // Optional user_id filter
    if (dto.user_id) {
      conditions.push('e.user_id = {user_id:String}');
      params.user_id = dto.user_id;
    }

    const whereClause = conditions.join(' AND ');

    // S6 Lot C — enrich each exported event with the user's STITCHED first-touch
    // acquisition (+ referral_code). These columns do NOT live on the `events`
    // table (events have a 7d TTL); they live on the canonical `user_attribution`
    // table, one row per user_id (ReplacingMergeTree → read with FINAL). We
    // LEFT JOIN by user_id so events of a not-yet-stitched user simply get empty
    // first-touch fields (never dropped). The join table must be DB-qualified
    // explicitly: ClickHouseService.qualifyTableNames only rewrites FROM/INTO,
    // not JOIN. `events FINAL e` already resolves to the workspace DB via FROM.
    const dbName = this.clickhouse.getWorkspaceDatabaseName(dto.workspace_id);

    const sql = `
      SELECT
        toString(e.id) as id,
        e.session_id as session_id,
        e.user_id as user_id,
        e.name as name,
        e.path as path,
        toString(e.created_at) as created_at,
        toString(e.updated_at) as updated_at,
        e.referrer as referrer,
        e.referrer_domain as referrer_domain,
        e.is_direct as is_direct,
        e.landing_page as landing_page,
        e.landing_domain as landing_domain,
        e.landing_path as landing_path,
        e.utm_source as utm_source,
        e.utm_medium as utm_medium,
        e.utm_campaign as utm_campaign,
        e.utm_term as utm_term,
        e.utm_content as utm_content,
        e.utm_id as utm_id,
        e.utm_id_from as utm_id_from,
        e.channel as channel,
        e.channel_group as channel_group,
        ua.first_touch_channel as first_touch_channel,
        ua.first_touch_channel_group as first_touch_channel_group,
        ua.first_touch_referrer as first_touch_referrer,
        ua.first_touch_referrer_domain as first_touch_referrer_domain,
        ua.first_touch_landing_page as first_touch_landing_page,
        ua.first_touch_utm_source as first_touch_utm_source,
        ua.first_touch_utm_medium as first_touch_utm_medium,
        ua.first_touch_utm_campaign as first_touch_utm_campaign,
        ua.first_touch_method as first_touch_method,
        ua.referral_code as referral_code,
        e.stm_1 as stm_1,
        e.stm_2 as stm_2,
        e.stm_3 as stm_3,
        e.stm_4 as stm_4,
        e.stm_5 as stm_5,
        e.stm_6 as stm_6,
        e.stm_7 as stm_7,
        e.stm_8 as stm_8,
        e.stm_9 as stm_9,
        e.stm_10 as stm_10,
        e.device as device,
        e.browser as browser,
        e.browser_type as browser_type,
        e.os as os,
        e.country as country,
        e.region as region,
        e.city as city,
        e.language as language,
        e.timezone as timezone,
        e.goal_name as goal_name,
        e.goal_value as goal_value,
        toString(e.goal_timestamp) as goal_timestamp,
        e.page_number as page_number,
        e.duration as duration,
        e.max_scroll as max_scroll,
        e.properties as properties
      FROM events AS e FINAL
      LEFT JOIN ${dbName}.user_attribution AS ua FINAL ON ua.user_id = e.user_id
      WHERE ${whereClause}
      ORDER BY e.updated_at ASC, e.id ASC
      LIMIT ${limit + 1}
    `;

    const rows = await this.clickhouse.queryWorkspace<UserEventRow>(
      dto.workspace_id,
      sql,
      params,
    );

    // Determine if there are more rows
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;

    // Generate next cursor from last item
    let nextCursor: string | null = null;
    if (hasMore && data.length > 0) {
      const lastItem = data[data.length - 1];
      const cursorPayload: CursorData = {
        updated_at: lastItem.updated_at,
        id: lastItem.id,
      };
      nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString(
        'base64',
      );
    }

    return {
      data,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  }

  private toClickHouseDateTime(date: Date): string {
    return date.toISOString().replace('T', ' ').replace('Z', '');
  }
}
