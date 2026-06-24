import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PHONE_NUMBER_SOURCES } from '../../voip/voip.types';
import type { PhoneSource, VoipCredentialKind } from '../../voip/voip.types';
import { IsE164 } from '../../common/validators/e164.validator';

/**
 * VoIP M2M admin DTOs.
 *
 * Mirror the workspace-scoped voip.dto.ts contracts but live behind
 * PlatformAdminGuard so an IA can wire a tenant's telephony end-to-end
 * (credentials + tracked numbers + sync) without the console.
 *
 * Secrets are write-only everywhere: `creds` is encrypted at rest and never
 * echoed back; list/status responses are the masked `PublicVoipCredential`.
 */

const KINDS: VoipCredentialKind[] = ['voip_ovh', 'voip_telnyx'];
const SOURCES = PHONE_NUMBER_SOURCES as readonly string[];

/** POST workspaces' voip.listPhoneNumbers / voip.listCredentials body. */
export class VoipWorkspaceDto {
  @ApiProperty({ description: 'Workspace to read VoIP config for.' })
  @IsString()
  @IsNotEmpty()
  workspace_id: string;
}

/** POST voip.saveCredential — register/replace an (encrypted) VoIP credential. */
export class VoipSaveCredentialDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ enum: KINDS })
  @IsString()
  @IsIn(KINDS)
  kind: VoipCredentialKind;

  /** Provider creds in clear; encrypted at rest, NEVER returned. */
  @ApiProperty({
    description: 'Provider creds; encrypted at rest, never returned.',
  })
  @IsObject()
  creds: Record<string, unknown>;
}

/** POST voip.testCredential / voip.deleteCredential. */
export class VoipCredentialKindDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ enum: KINDS })
  @IsString()
  @IsIn(KINDS)
  kind: VoipCredentialKind;
}

/** POST voip.addPhoneNumber — map a phone number to a traffic source. */
export class VoipAddPhoneNumberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  // Single shared phone-number contract with tenants.provision' PhoneNumberDto
  // (was @MaxLength(32)+@IsNotEmpty here vs @Length(8,20) there — same number
  // could be accepted by one route, rejected by the other). @IsE164 accepts
  // E.164 + the FR formats the service auto-normalises (0…/00…), so it does NOT
  // break that normalisation.
  @ApiProperty({ example: '+33177123456' })
  @IsString()
  @IsE164()
  e164: string;

  @ApiProperty({ enum: SOURCES })
  @IsString()
  @IsIn(SOURCES)
  source: PhoneSource;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;
}

/** POST voip.removePhoneNumber — soft-delete a tracked number by id. */
export class VoipRemovePhoneNumberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;
}
