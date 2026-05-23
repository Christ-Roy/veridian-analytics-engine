import { App, Drawer, Form, Input, InputNumber, Select, Switch, Button, Space } from 'antd'
import { ExperimentOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { api } from '../../lib/api'
import { ConditionsBuilder } from './ConditionsBuilder'
import { OperationsBuilder } from './OperationsBuilder'
import { TestFilterModal } from './TestFilterModal'
import type {
  FilterWithStaleness,
  FilterCondition,
  FilterOperation,
} from '../../types/filters'
import { SUGGESTED_TAGS } from '../../types/filters'
import type { CustomDimensionLabels } from '../../types/workspace'

interface FilterFormModalProps {
  workspaceId: string
  filter?: FilterWithStaleness
  existingTags: string[]
  customDimensionLabels?: CustomDimensionLabels | null
  open: boolean
  onClose: () => void
}

interface FormValues {
  name: string
  priority: number
  tags: string[]
  enabled: boolean
  conditions: FilterCondition[]
  operations: FilterOperation[]
}

export function FilterFormModal({
  workspaceId,
  filter,
  existingTags,
  customDimensionLabels,
  open,
  onClose,
}: FilterFormModalProps) {
  const { message } = App.useApp()
  const [form] = Form.useForm<FormValues>()
  const queryClient = useQueryClient()
  const isEditing = !!filter
  const [testModalOpen, setTestModalOpen] = useState(false)

  const tagOptions = useMemo(() => {
    const allTags = new Set([...existingTags, ...SUGGESTED_TAGS])
    return Array.from(allTags).map((tag) => ({ value: tag, label: tag }))
  }, [existingTags])

  useEffect(() => {
    if (open) {
      if (filter) {
        form.setFieldsValue({
          name: filter.name,
          priority: filter.priority,
          tags: filter.tags,
          enabled: filter.enabled,
          conditions: filter.conditions,
          operations: filter.operations,
        })
      } else {
        form.resetFields()
        form.setFieldsValue({
          priority: 500,
          tags: [],
          enabled: true,
          conditions: [
            { field: 'utm_source', operator: 'equals', value: '' },
          ],
          operations: [
            { dimension: 'channel', action: 'set_value', value: '' },
          ],
        })
      }
    }
  }, [open, filter, form])

  const createMutation = useMutation({
    mutationFn: api.filters.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filters', workspaceId] })
      queryClient.invalidateQueries({ queryKey: ['filters', workspaceId, 'tags'] })
      queryClient.invalidateQueries({ queryKey: ['backfill', 'summary', workspaceId] })
      message.success('Filter created')
      onClose()
    },
    onError: () => {
      message.error('Failed to create filter')
    },
  })

  const updateMutation = useMutation({
    mutationFn: api.filters.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['filters', workspaceId] })
      queryClient.invalidateQueries({ queryKey: ['filters', workspaceId, 'tags'] })
      queryClient.invalidateQueries({ queryKey: ['backfill', 'summary', workspaceId] })
      message.success('Filter updated')
      onClose()
    },
    onError: () => {
      message.error('Failed to update filter')
    },
  })

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()

      if (isEditing && filter) {
        await updateMutation.mutateAsync({
          workspace_id: workspaceId,
          id: filter.id,
          name: values.name,
          priority: values.priority,
          tags: values.tags,
          enabled: values.enabled,
          conditions: values.conditions,
          operations: values.operations,
        })
      } else {
        await createMutation.mutateAsync({
          workspace_id: workspaceId,
          name: values.name,
          priority: values.priority,
          tags: values.tags,
          enabled: values.enabled,
          conditions: values.conditions,
          operations: values.operations,
        })
      }
    } catch {
      // Validation failed
    }
  }

  const handleTest = () => {
    setTestModalOpen(true)
  }

  const isPending = createMutation.isPending || updateMutation.isPending

  const currentConditions = Form.useWatch('conditions', form) || []
  const currentOperations = Form.useWatch('operations', form) || []

  return (
    <>
      <Drawer
        title={isEditing ? 'Edit Filter' : 'Create Filter'}
        open={open}
        onClose={onClose}
        size={800}
        placement="right"
        destroyOnClose
        styles={{ wrapper: { maxWidth: '100%' } }}
        footer={
          <div className="flex justify-between">
            <Button onClick={handleTest} icon={<ExperimentOutlined />}>
              Tester
            </Button>
            <Space>
              <Button onClick={onClose}>Annuler</Button>
              <Button type="primary" onClick={handleSubmit} loading={isPending}>
                {isEditing ? 'Enregistrer' : 'Créer'}
              </Button>
            </Space>
          </div>
        }
      >
        <Form form={form} layout="vertical">
          <div className="grid grid-cols-3 gap-4">
            <Form.Item
              name="name"
              label="Nom"
              rules={[{ required: true, message: 'Le nom est obligatoire' }]}
              className="col-span-2"
            >
              <Input placeholder="ex : Définir le canal pour Google Ads" />
            </Form.Item>

            <Form.Item
              name="priority"
              label="Priorité"
              tooltip="Les filtres de priorité plus élevée sont évalués en premier (0-1000)"
              rules={[{ required: true, message: 'La priorité est obligatoire' }]}
            >
              <InputNumber min={0} max={1000} className="w-full" />
            </Form.Item>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <Form.Item name="tags" label="Tags" className="col-span-2">
              <Select
                mode="tags"
                options={tagOptions}
                placeholder="Ajouter des tags…"
                tokenSeparators={[',']}
              />
            </Form.Item>

            <Form.Item name="enabled" label="Activé" valuePropName="checked">
              <Switch />
            </Form.Item>
          </div>

          <Form.Item
            name="conditions"
            label="Conditions"
            validateTrigger={[]}
            rules={[
              { required: true, message: 'Au moins une condition est requise' },
              {
                validator: (_, conditions: FilterCondition[]) => {
                  if (!conditions || conditions.length === 0) {
                    return Promise.reject('Au moins une condition est requise')
                  }
                  for (const condition of conditions) {
                    if (!condition.value?.trim()) {
                      return Promise.reject('Toutes les conditions doivent avoir une valeur')
                    }
                  }
                  return Promise.resolve()
                },
              },
            ]}
          >
            <ConditionsBuilder
              value={form.getFieldValue('conditions') || []}
              onChange={(conditions) => form.setFieldValue('conditions', conditions)}
            />
          </Form.Item>

          <Form.Item
            name="operations"
            label="Opérations"
            validateTrigger={[]}
            rules={[
              { required: true, message: 'Au moins une opération est requise' },
              {
                validator: (_, operations: FilterOperation[]) => {
                  if (!operations || operations.length === 0) {
                    return Promise.reject('Au moins une opération est requise')
                  }
                  for (const op of operations) {
                    if ((op.action === 'set_value' || op.action === 'set_default_value') && !op.value?.trim()) {
                      return Promise.reject(`Une valeur est requise pour l'action ${op.action}`)
                    }
                  }
                  return Promise.resolve()
                },
              },
            ]}
          >
            <OperationsBuilder
              value={form.getFieldValue('operations') || []}
              onChange={(operations) => form.setFieldValue('operations', operations)}
              customDimensionLabels={customDimensionLabels}
            />
          </Form.Item>
        </Form>
      </Drawer>

      <TestFilterModal
        conditions={currentConditions}
        operations={currentOperations}
        customDimensionLabels={customDimensionLabels}
        open={testModalOpen}
        onClose={() => setTestModalOpen(false)}
      />
    </>
  )
}
