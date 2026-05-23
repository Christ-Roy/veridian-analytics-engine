import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table,
  Button,
  Tag,
  Select,
  Space,
  Popconfirm,
  App,
  Typography,
  Tooltip,
  Avatar,
  Empty,
} from 'antd'
import {
  UserAddOutlined,
  DeleteOutlined,
  CrownOutlined,
  ReloadOutlined,
  CloseOutlined,
} from '@ant-design/icons'
import md5 from 'blueimp-md5'
import { api } from '../../lib/api'
import { InviteMemberModal } from './InviteMemberModal'
import type { Member, Invitation, Role } from '../../types/member'

// Generate Gravatar URL from email
function getGravatarUrl(email: string, size = 40): string {
  const hash = md5(email.trim().toLowerCase())
  return `https://www.gravatar.com/avatar/${hash}?s=${size}&d=identicon`
}

const { Title, Text } = Typography

interface TeamSettingsProps {
  workspaceId: string
  userRole: Role
}

const roleColors: Record<Role, string> = {
  owner: 'gold',
  admin: 'purple',
  editor: 'blue',
  viewer: 'default',
}

const roleOptions = [
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Éditeur' },
  { value: 'viewer', label: 'Lecteur' },
]

const ROLE_LABELS_FR: Record<Role, string> = {
  owner: 'Propriétaire',
  admin: 'Admin',
  editor: 'Éditeur',
  viewer: 'Lecteur',
}

export function TeamSettings({ workspaceId, userRole }: TeamSettingsProps) {
  const queryClient = useQueryClient()
  const { message } = App.useApp()
  const [inviteModalOpen, setInviteModalOpen] = useState(false)

  const canManageMembers = userRole === 'owner' || userRole === 'admin'

  // Fetch current user
  const { data: currentUser } = useQuery({
    queryKey: ['user'],
    queryFn: api.auth.me,
  })

  // Fetch members
  const {
    data: members = [],
    isLoading: membersLoading,
  } = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.members.list(workspaceId),
  })

  // Fetch pending invitations
  const {
    data: invitations = [],
    isLoading: invitationsLoading,
  } = useQuery({
    queryKey: ['invitations', workspaceId],
    queryFn: () => api.invitations.list(workspaceId),
    enabled: canManageMembers,
  })

  // Fetch SMTP status to check if invitations can be sent
  const { data: smtpInfo } = useQuery({
    queryKey: ['smtp-info', workspaceId],
    queryFn: () => api.smtp.info(workspaceId),
    enabled: canManageMembers,
    staleTime: 30_000,
  })
  const smtpStatus = smtpInfo?.status

  // Update role mutation
  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Exclude<Role, 'owner'> }) =>
      api.members.updateRole(workspaceId, userId, role),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', workspaceId] })
      message.success('Rôle mis à jour')
    },
    onError: (error: Error) => {
      message.error(error.message)
    },
  })

  // Remove member mutation
  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => api.members.remove(workspaceId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['members', workspaceId] })
      message.success('Membre retiré')
    },
    onError: (error: Error) => {
      message.error(error.message)
    },
  })

  // Revoke invitation mutation
  const revokeInvitationMutation = useMutation({
    mutationFn: (id: string) => api.invitations.revoke(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['invitations', workspaceId] })
      message.success('Invitation révoquée')
    },
    onError: (error: Error) => {
      message.error(error.message)
    },
  })

  // Resend invitation mutation
  const resendInvitationMutation = useMutation({
    mutationFn: (id: string) => api.invitations.resend(id),
    onSuccess: () => {
      message.success('Invitation renvoyée')
    },
    onError: (error: Error) => {
      message.error(error.message)
    },
  })

  // Member columns
  const memberColumns = [
    {
      title: 'Membre',
      key: 'member',
      render: (_: unknown, record: Member) => (
        <Space>
          <Avatar size="small" src={getGravatarUrl(record.user.email, 32)}>
            {record.user.name.charAt(0).toUpperCase()}
          </Avatar>
          <div>
            <div className="font-medium">{record.user.name}</div>
            <div className="text-gray-500 text-sm">{record.user.email}</div>
          </div>
        </Space>
      ),
    },
    {
      title: 'Rôle',
      key: 'role',
      width: 150,
      render: (_: unknown, record: Member) => {
        const isCurrentUser = record.user_id === currentUser?.id
        const canChangeRole =
          canManageMembers &&
          record.role !== 'owner' &&
          !isCurrentUser &&
          (userRole === 'owner' || record.role !== 'admin')

        if (record.role === 'owner') {
          return (
            <Tag color={roleColors.owner} icon={<CrownOutlined />}>
              {ROLE_LABELS_FR.owner}
            </Tag>
          )
        }

        if (canChangeRole) {
          return (
            <Select
              value={record.role}
              options={roleOptions}
              size="small"
              style={{ width: 100 }}
              loading={updateRoleMutation.isPending}
              onChange={(role) =>
                updateRoleMutation.mutate({
                  userId: record.user_id,
                  role: role as Exclude<Role, 'owner'>,
                })
              }
            />
          )
        }

        return (
          <Tag color={roleColors[record.role]}>
            {ROLE_LABELS_FR[record.role]}
          </Tag>
        )
      },
    },
    {
      title: 'Date d\'adhésion',
      key: 'joined_at',
      width: 120,
      render: (_: unknown, record: Member) => (
        <Text type="secondary">
          {new Date(record.joined_at).toLocaleDateString('fr-FR')}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 80,
      align: 'right' as const,
      render: (_: unknown, record: Member) => {
        const isCurrentUser = record.user_id === currentUser?.id
        const canRemove =
          canManageMembers &&
          record.role !== 'owner' &&
          !isCurrentUser &&
          (userRole === 'owner' || record.role !== 'admin')

        if (!canRemove) return null

        return (
          <Popconfirm
            title="Retirer le membre"
            description={`Êtes-vous sûr de vouloir retirer ${record.user.name} ?`}
            onConfirm={() => removeMemberMutation.mutate(record.user_id)}
            okText="Retirer"
            cancelText="Annuler"
          >
            <Tooltip title="Retirer le membre">
              <Button
                type="text"
                icon={<DeleteOutlined />}
                size="small"
                loading={removeMemberMutation.isPending}
              />
            </Tooltip>
          </Popconfirm>
        )
      },
    },
  ]

  // Invitation columns
  const invitationColumns = [
    {
      title: 'Email',
      key: 'email',
      render: (_: unknown, record: Invitation) => (
        <Space>
          <Avatar size="small" src={getGravatarUrl(record.email, 32)}>
            {record.email.charAt(0).toUpperCase()}
          </Avatar>
          <span>{record.email}</span>
        </Space>
      ),
    },
    {
      title: 'Rôle',
      key: 'role',
      width: 100,
      render: (_: unknown, record: Invitation) => (
        <Tag color={roleColors[record.role]}>
          {ROLE_LABELS_FR[record.role]}
        </Tag>
      ),
    },
    {
      title: 'Invité par',
      key: 'inviter',
      width: 150,
      render: (_: unknown, record: Invitation) => (
        <Text type="secondary">{record.inviter.name}</Text>
      ),
    },
    {
      title: 'Expiration',
      key: 'expires_at',
      width: 120,
      render: (_: unknown, record: Invitation) => (
        <Text type="secondary">
          {new Date(record.expires_at).toLocaleDateString('fr-FR')}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 100,
      align: 'right' as const,
      render: (_: unknown, record: Invitation) => (
        <Space>
          <Popconfirm
            title="Révoquer l'invitation"
            description={`Êtes-vous sûr de vouloir révoquer l'invitation pour ${record.email} ?`}
            onConfirm={() => revokeInvitationMutation.mutate(record.id)}
            okText="Révoquer"
            cancelText="Annuler"
          >
            <Tooltip title="Révoquer l'invitation">
              <Button
                type="text"
                icon={<CloseOutlined />}
                size="small"
                loading={revokeInvitationMutation.isPending}
              />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title="Renvoyer l'invitation"
            description={`Renvoyer l'email d'invitation à ${record.email} ?`}
            onConfirm={() => resendInvitationMutation.mutate(record.id)}
            okText="Renvoyer"
            cancelText="Annuler"
            disabled={!smtpStatus?.available}
          >
            <Tooltip title={!smtpStatus?.available ? 'SMTP non configuré' : "Renvoyer l'invitation"}>
              <Button
                type="text"
                icon={<ReloadOutlined />}
                size="small"
                loading={resendInvitationMutation.isPending}
                disabled={!smtpStatus?.available}
              />
            </Tooltip>
          </Popconfirm>
        </Space>
      ),
    },
  ]

  const pendingInvitations = invitations.filter(
    (inv: Invitation) => inv.status === 'pending'
  )

  return (
    <div className="space-y-6 max-w-xl">
      {/* Members Section */}
      <div>
        <div className="flex justify-between items-center mb-4">
          <Title level={5} className="!mb-0">
            Membres de l'équipe ({members.length})
          </Title>
          {canManageMembers && (
            <Tooltip
              title={!smtpStatus?.available ? 'SMTP non configuré. Configurez d\'abord les paramètres SMTP.' : undefined}
            >
              <Button
                type="primary"
                icon={<UserAddOutlined />}
                onClick={() => setInviteModalOpen(true)}
                disabled={!smtpStatus?.available}
              >
                <span className="hidden md:inline">Inviter un membre</span>
                <span className="md:hidden">Inviter</span>
              </Button>
            </Tooltip>
          )}
        </div>

        {/* Mobile: Card view */}
        <div className="md:hidden space-y-3">
          {membersLoading ? (
            <div className="bg-white rounded-lg p-6 text-center text-gray-500">Chargement…</div>
          ) : members.length === 0 ? (
            <div className="bg-white rounded-lg p-6">
              <Empty description="Aucun membre dans l'équipe" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            members.map((member) => {
              const isCurrentUser = member.user_id === currentUser?.id
              const canChangeRole =
                canManageMembers &&
                member.role !== 'owner' &&
                !isCurrentUser &&
                (userRole === 'owner' || member.role !== 'admin')
              const canRemove =
                canManageMembers &&
                member.role !== 'owner' &&
                !isCurrentUser &&
                (userRole === 'owner' || member.role !== 'admin')

              return (
                <div key={member.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-start gap-3">
                    <Avatar size="default" src={getGravatarUrl(member.user.email, 40)}>
                      {member.user.name.charAt(0).toUpperCase()}
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-medium">{member.user.name}</div>
                          <div className="text-gray-500 text-sm truncate">{member.user.email}</div>
                        </div>
                        <div className="shrink-0">
                          {member.role === 'owner' ? (
                            <Tag color={roleColors.owner} icon={<CrownOutlined />}>{ROLE_LABELS_FR.owner}</Tag>
                          ) : canChangeRole ? (
                            <Select
                              value={member.role}
                              options={roleOptions}
                              size="small"
                              style={{ width: 100 }}
                              loading={updateRoleMutation.isPending}
                              onChange={(role) =>
                                updateRoleMutation.mutate({
                                  userId: member.user_id,
                                  role: role as Exclude<Role, 'owner'>,
                                })
                              }
                            />
                          ) : (
                            <Tag color={roleColors[member.role]}>
                              {ROLE_LABELS_FR[member.role]}
                            </Tag>
                          )}
                        </div>
                      </div>
                      <div className="text-gray-400 text-xs mt-2">
                        Membre depuis le {new Date(member.joined_at).toLocaleDateString('fr-FR')}
                      </div>
                    </div>
                  </div>
                  {canRemove && (
                    <div className="mt-3 pt-3 border-t border-gray-100">
                      <Popconfirm
                        title="Retirer le membre"
                        description={`Êtes-vous sûr de vouloir retirer ${member.user.name} ?`}
                        onConfirm={() => removeMemberMutation.mutate(member.user_id)}
                        okText="Retirer"
                        cancelText="Annuler"
                      >
                        <Button block size="small" icon={<DeleteOutlined />} loading={removeMemberMutation.isPending}>
                          Retirer
                        </Button>
                      </Popconfirm>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        {/* Desktop: Table view */}
        <div className="hidden md:block">
          <Table
            dataSource={members}
            columns={memberColumns}
            rowKey="id"
            loading={membersLoading}
            pagination={false}
            size="middle"
          />
        </div>
      </div>

      {/* Pending Invitations Section - only show if there are pending invitations */}
      {canManageMembers && pendingInvitations.length > 0 && (
        <div>
          <Title level={5} className="!mt-8 !mb-4">
            Invitations en attente ({pendingInvitations.length})
          </Title>

          {/* Mobile: Card view */}
          <div className="md:hidden space-y-3">
            {invitationsLoading ? (
              <div className="bg-white rounded-lg p-6 text-center text-gray-500">Chargement…</div>
            ) : (
              pendingInvitations.map((invitation) => (
                <div key={invitation.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-start gap-3">
                    <Avatar size="default" src={getGravatarUrl(invitation.email, 40)}>
                      {invitation.email.charAt(0).toUpperCase()}
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="font-medium truncate">{invitation.email}</div>
                        <div className="shrink-0">
                          <Tag color={roleColors[invitation.role]}>
                            {ROLE_LABELS_FR[invitation.role]}
                          </Tag>
                        </div>
                      </div>
                      <div className="text-gray-400 text-xs mt-2">
                        Invité par {invitation.inviter.name} · Expire le {new Date(invitation.expires_at).toLocaleDateString('fr-FR')}
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                    <Popconfirm
                      title="Révoquer l'invitation"
                      description={`Êtes-vous sûr de vouloir révoquer l'invitation pour ${invitation.email} ?`}
                      onConfirm={() => revokeInvitationMutation.mutate(invitation.id)}
                      okText="Révoquer"
                      cancelText="Annuler"
                    >
                      <Button block size="small" icon={<CloseOutlined />} loading={revokeInvitationMutation.isPending}>
                        Révoquer
                      </Button>
                    </Popconfirm>
                    <Popconfirm
                      title="Renvoyer l'invitation"
                      description={`Renvoyer l'email d'invitation à ${invitation.email} ?`}
                      onConfirm={() => resendInvitationMutation.mutate(invitation.id)}
                      okText="Renvoyer"
                      cancelText="Annuler"
                      disabled={!smtpStatus?.available}
                    >
                      <Button
                        block
                        size="small"
                        icon={<ReloadOutlined />}
                        loading={resendInvitationMutation.isPending}
                        disabled={!smtpStatus?.available}
                      >
                        Renvoyer
                      </Button>
                    </Popconfirm>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Desktop: Table view */}
          <div className="hidden md:block">
            <Table
              dataSource={pendingInvitations}
              columns={invitationColumns}
              rowKey="id"
              loading={invitationsLoading}
              pagination={false}
              size="middle"
            />
          </div>
        </div>
      )}

      {/* Invite Modal */}
      <InviteMemberModal
        open={inviteModalOpen}
        onClose={() => setInviteModalOpen(false)}
        workspaceId={workspaceId}
        onSuccess={() => {
          setInviteModalOpen(false)
          queryClient.invalidateQueries({ queryKey: ['invitations', workspaceId] })
        }}
      />
    </div>
  )
}
