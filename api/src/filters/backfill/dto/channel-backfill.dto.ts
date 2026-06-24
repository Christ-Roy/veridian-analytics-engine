import { IsString } from 'class-validator';

/**
 * Trigger a synchronous re-derivation of channel/channel_group on the historical
 * sessions + goals of a workspace (ticket channel-group-vide-sessions-historiques).
 */
export class ChannelBackfillDto {
  @IsString()
  workspace_id: string;
}
