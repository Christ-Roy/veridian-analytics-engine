/**
 * SECU P0 — `SetupService.createInitialAdmin` doit refuser tout appel
 * si l'admin a déjà été bootstrap (`setup_completed = 'true'`).
 *
 * Bug d'origine : la page `/setup` répondait HTTP 200 publiquement sur
 * prod (`https://analytics-engine.app.veridian.site/setup`) alors que
 * l'admin était déjà bootstrap → un attacker pouvait théoriquement créer
 * un compte admin shadow si le backend dysfonctionnait. La défense en
 * profondeur exige que les DEUX couches (frontend + backend) refusent.
 *
 * Ce spec verrouille la couche backend.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { SetupService } from './setup.service';
import { ClickHouseService } from '../database/clickhouse.service';
import { UsersService } from '../users/users.service';

describe('SetupService — SECU bootstrap lock', () => {
  let service: SetupService;
  let clickhouse: jest.Mocked<ClickHouseService>;
  let usersService: jest.Mocked<UsersService>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SetupService,
        {
          provide: ClickHouseService,
          useValue: {
            querySystem: jest.fn(),
            insertSystem: jest.fn(),
          },
        },
        {
          provide: UsersService,
          useValue: {
            findByEmail: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            sign: jest.fn().mockReturnValue('fake.jwt.token'),
          },
        },
      ],
    }).compile();

    service = module.get<SetupService>(SetupService);
    clickhouse = module.get(ClickHouseService);
    usersService = module.get(UsersService);

    jest.clearAllMocks();
  });

  describe('isSetupComplete', () => {
    it('returns true when system_settings has setup_completed=true', async () => {
      clickhouse.querySystem.mockResolvedValue([{ value: 'true' }]);

      const result = await service.isSetupComplete();

      expect(result).toBe(true);
    });

    it('returns false when system_settings is empty', async () => {
      clickhouse.querySystem.mockResolvedValue([]);

      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });

    it('returns false when value is not "true"', async () => {
      clickhouse.querySystem.mockResolvedValue([{ value: 'false' }]);

      const result = await service.isSetupComplete();

      expect(result).toBe(false);
    });
  });

  describe('createInitialAdmin — bootstrap lock', () => {
    it('REFUSES creation when setup is already complete (4xx, never 2xx)', async () => {
      // setup_completed=true → endpoint must lock
      clickhouse.querySystem.mockResolvedValue([{ value: 'true' }]);

      await expect(
        service.createInitialAdmin(
          'attacker@evil.example',
          'someStrongPw123!',
          'Attacker',
        ),
      ).rejects.toThrow(BadRequestException);

      // Sanity check : aucune écriture en DB n'a été tentée
      expect(clickhouse.insertSystem).not.toHaveBeenCalled();
      // Et on n'a même pas regardé si l'email existait — fail-fast sur le lock
      expect(usersService.findByEmail).not.toHaveBeenCalled();
    });

    it('REFUSES with "already been completed" message (audit trail)', async () => {
      clickhouse.querySystem.mockResolvedValue([{ value: 'true' }]);

      await expect(
        service.createInitialAdmin('a@b.c', 'pw12345678', 'name'),
      ).rejects.toMatchObject({
        message: expect.stringMatching(/already been completed/i),
      });
    });

    it('REFUSES even if email is new (race condition guard)', async () => {
      // Cas tordu : setup complet ET user avec cet email n'existe pas.
      // On doit quand même refuser — le verrou est sur le flag, pas sur l'email.
      clickhouse.querySystem.mockResolvedValue([{ value: 'true' }]);
      usersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.createInitialAdmin(
          'totally-new-email@evil.example',
          'someStrongPw123!',
          'New Attacker',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(clickhouse.insertSystem).not.toHaveBeenCalled();
    });
  });
});
