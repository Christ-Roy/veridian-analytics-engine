import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Corps de `POST /api/sso.issueToken`, envoyé par le Hub.
 *
 * Le corps est intégralement couvert par la signature HMAC : le modifier en
 * transit invalide la requête. C'est ce qui empêche un intermédiaire de
 * réorienter un jeton légitime vers l'email d'un autre client.
 */
export class IssueTokenDto {
  @ApiPropertyOptional({
    description:
      "Email du compte Analytics à connecter. Aujourd'hui le seul identifiant résoluble par l'engine.",
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({
    description:
      "Identifiant du user côté Hub. Conservé pour l'audit et la corrélation entre les deux systèmes ; ne sert pas encore à résoudre le compte (l'engine ne stocke aucune correspondance).",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  hub_user_id?: string;

  @ApiPropertyOptional({
    description:
      "Workspace cible. Fortement recommandé : le jeton y est alors LIÉ et l'appartenance du user est vérifiée à l'émission, ce qui empêche structurellement qu'il ouvre l'espace d'un autre client. Omis, on retombe sur le premier workspace du user.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  workspace_id?: string;
}

/**
 * Corps de `POST /api/sso.exchange`, envoyé par la page console `/sso`.
 *
 * Le jeton voyage dans un CORPS de requête, jamais dans une URL côté serveur :
 * il n'apparaît donc dans aucun log d'accès ni en-tête `Referer`.
 */
export class ExchangeTokenDto {
  @ApiProperty({ description: "Jeton d'autologin à usage unique." })
  @IsString()
  @MaxLength(256)
  token!: string;
}
