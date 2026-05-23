import { useState } from 'react'
import { Modal, Form, Input, Select, Button, Alert } from 'antd'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface InviteMemberModalProps {
  open: boolean
  onClose: () => void
  workspaceId: string
  onSuccess: () => void
}

const roleOptions = [
  {
    value: 'admin',
    label: 'Admin',
    description: 'Peut gérer les paramètres, les membres et les intégrations',
  },
  {
    value: 'editor',
    label: 'Éditeur',
    description: 'Peut consulter les analytics, créer des filtres et des annotations',
  },
  {
    value: 'viewer',
    label: 'Lecteur',
    description: 'Peut uniquement consulter les tableaux de bord et les analytics',
  },
]

export function InviteMemberModal({
  open,
  onClose,
  workspaceId,
  onSuccess,
}: InviteMemberModalProps) {
  const [form] = Form.useForm()
  const [error, setError] = useState<string | null>(null)

  const inviteMutation = useMutation({
    mutationFn: ({ email, role }: { email: string; role: string }) =>
      api.invitations.create(workspaceId, email, role as 'admin' | 'editor' | 'viewer'),
    onSuccess: () => {
      form.resetFields()
      setError(null)
      onSuccess()
    },
    onError: (err: Error) => {
      setError(err.message)
    },
  })

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()
      inviteMutation.mutate(values)
    } catch {
      // Form validation failed
    }
  }

  const handleCancel = () => {
    form.resetFields()
    setError(null)
    onClose()
  }

  return (
    <Modal
      title="Inviter un membre de l'équipe"
      open={open}
      onCancel={handleCancel}
      footer={[
        <Button key="cancel" onClick={handleCancel}>
          Annuler
        </Button>,
        <Button
          key="submit"
          type="primary"
          loading={inviteMutation.isPending}
          onClick={handleSubmit}
        >
          Envoyer l'invitation
        </Button>,
      ]}
    >
      {error && (
        <Alert
          title={error}
          type="error"
          showIcon
          className="mb-4"
          closable
          onClose={() => setError(null)}
        />
      )}

      <Form
        form={form}
        layout="vertical"
        initialValues={{ role: 'editor' }}
      >
        <Form.Item
          name="email"
          label="Adresse email"
          rules={[
            { required: true, message: 'Veuillez saisir une adresse email' },
            { type: 'email', message: 'Veuillez saisir un email valide' },
          ]}
        >
          <Input
            placeholder="collegue@entreprise.fr"
            autoComplete="email"
          />
        </Form.Item>

        <Form.Item
          name="role"
          label="Rôle"
          rules={[{ required: true, message: 'Veuillez sélectionner un rôle' }]}
        >
          <Select
            options={roleOptions.map((opt) => ({
              value: opt.value,
              label: (
                <div>
                  <div className="font-medium">{opt.label}</div>
                  <div className="text-xs text-gray-500">{opt.description}</div>
                </div>
              ),
            }))}
            optionLabelProp="value"
          />
        </Form.Item>
      </Form>

      <div className="text-sm text-gray-500 mt-4">
        Un email d'invitation sera envoyé à cette adresse. L'invitation expire
        sous 7 jours.
      </div>
    </Modal>
  )
}
