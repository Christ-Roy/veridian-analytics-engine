import {
  IsString,
  IsArray,
  IsOptional,
  ValidateNested,
  ArrayMinSize,
  ArrayMaxSize,
  IsInt,
  Min,
  Max,
  Validate,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  DateRangeDto,
  DateRangeValidator,
  FilterDto,
} from './analytics-query.dto';
import { IsIanaTimezone } from '../../common/validators/timezone.validator';

/**
 * Une étape de funnel = un `goal_name` (ou n'importe quel event `name`).
 * On garde volontairement simple : chaque étape = un nom d'objectif. L'ordre du
 * tableau `steps` définit la séquence du tunnel.
 */
export class FunnelStepDto {
  @IsString()
  goal_name: string;

  /** Libellé affiché (optionnel) ; défaut = goal_name. */
  @IsOptional()
  @IsString()
  label?: string;
}

/**
 * DTO du funnel (tunnel de vente). Calcule, pour une séquence ordonnée d'étapes
 * (objectifs), combien de sessions/visiteurs atteignent chaque étape + les taux
 * de passage N→N+1 et global. Filtrable par canal (channel/channel_group) via
 * `filters`. Borné : 2..8 étapes.
 */
export class FunnelQueryDto {
  @IsString()
  workspace_id: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => FunnelStepDto)
  steps: FunnelStepDto[];

  @Validate(DateRangeValidator)
  @ValidateNested()
  @Type(() => DateRangeDto)
  dateRange: DateRangeDto;

  /**
   * Filtres dimensionnels (réutilise le contrat analytics) — typiquement
   * `{ dimension: 'channel_group', operator: 'equals', values: ['ads'] }`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FilterDto)
  filters?: FilterDto[];

  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  /**
   * Unité de progression dans le tunnel :
   *  - 'session' (défaut) : un même session_id doit franchir les étapes ;
   *  - 'visitor'          : un même visitor_id (cross-session) franchit les étapes.
   */
  @IsOptional()
  @IsString()
  unit?: 'session' | 'visitor';

  /**
   * Fenêtre windowFunnel en secondes. Défaut = la plage de dates entière (les
   * étapes peuvent s'étaler sur toute la période). Bornée à 1..7776000 (90j).
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7_776_000)
  window_seconds?: number;
}

export interface FunnelStepResult {
  step: number;
  goal_name: string;
  label: string;
  /** Sessions/visiteurs ayant atteint CETTE étape (et donc toutes les précédentes). */
  count: number;
  /** Taux de passage depuis l'étape précédente (%) ; null pour l'étape 1. */
  conversion_from_previous: number | null;
  /** Taux global depuis l'étape 1 (%). */
  conversion_from_start: number;
  /** Abandons entre l'étape précédente et celle-ci. */
  dropoff_from_previous: number;
}

export interface FunnelResponse {
  workspace_id: string;
  unit: 'session' | 'visitor';
  dateRange: { start: string; end: string };
  /** Total d'unités entrées dans le tunnel (= count de l'étape 1). */
  entered: number;
  /** Taux de conversion bout-en-bout (étape 1 → dernière étape) en %. */
  overall_conversion: number;
  steps: FunnelStepResult[];
}
