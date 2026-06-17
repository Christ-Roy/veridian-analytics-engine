import {
  IsIn,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PHONE_NUMBER_SOURCES } from '../voip.types';
import type { PhoneSource, VoipCredentialKind } from '../voip.types';

const KINDS: VoipCredentialKind[] = ['voip_ovh', 'voip_telnyx'];
const SOURCES = PHONE_NUMBER_SOURCES as readonly string[];

/** POST /api/voip.saveCredential — enregistre/remplace un cred VoIP chiffré. */
export class SaveCredentialDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ enum: KINDS })
  @IsString()
  @IsIn(KINDS)
  kind: VoipCredentialKind;

  /** Creds en clair (forme dépend du provider). Chiffrés avant stockage. */
  @ApiProperty({ description: 'Provider creds; encrypted at rest, never returned.' })
  @IsObject()
  creds: Record<string, unknown>;
}

/** POST /api/voip.testCredential — teste un cred contre l'API provider. */
export class TestCredentialDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ enum: KINDS })
  @IsString()
  @IsIn(KINDS)
  kind: VoipCredentialKind;
}

/** POST /api/voip.deleteCredential — soft-delete un cred. */
export class DeleteCredentialDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ enum: KINDS })
  @IsString()
  @IsIn(KINDS)
  kind: VoipCredentialKind;
}

/** POST /api/voip.createPhoneNumber — mappe un numéro → source. */
export class CreatePhoneNumberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty({ example: '+33177123456' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
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

/** POST /api/voip.updatePhoneNumber — modifie source/label (pas le numéro). */
export class UpdatePhoneNumberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ enum: SOURCES, required: false })
  @IsOptional()
  @IsString()
  @IsIn(SOURCES)
  source?: PhoneSource;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string | null;
}

/** POST /api/voip.deletePhoneNumber */
export class DeletePhoneNumberDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  workspace_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  id: string;
}
