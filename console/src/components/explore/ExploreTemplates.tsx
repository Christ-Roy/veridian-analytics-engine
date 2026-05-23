import { useState } from 'react'
import { Card, Button, Tag } from 'antd'
import { Sparkles } from 'lucide-react'
import { BreakdownModal } from './BreakdownModal'
import { getDimensionLabel } from '../../lib/explore-utils'
import type { CustomDimensionLabels } from '../../types/workspace'
import type { Filter } from '../../types/analytics'

const operatorLabels: Record<string, string> = {
  equals: 'égal à',
  notEquals: 'différent de',
  contains: 'contient',
  notContains: 'ne contient pas',
  isEmpty: 'est vide',
  isNotEmpty: 'non vide',
  in: 'parmi',
  notIn: 'pas parmi',
}

interface ExploreTemplate {
  title: string
  description: string
  dimensions: string[]
  filters?: Filter[]
}

const templates: ExploreTemplate[] = [
  {
    title: 'Demander à l\'IA',
    description: 'Décrivez en français ce que vous voulez analyser',
    dimensions: []
  },
  {
    title: 'Rapport personnalisé',
    description: 'Créer un rapport sur mesure avec vos propres dimensions',
    dimensions: []
  },
  {
    title: 'Canaux non mappés',
    description: 'Trafic non classifié par les règles de filtres',
    dimensions: ['referrer_domain', 'utm_source', 'utm_medium', 'utm_campaign'],
    filters: [{ dimension: 'channel', operator: 'equals', values: ['not-mapped'] }]
  },
  {
    title: 'Campagnes UTM',
    description: 'Comparer le TimeScore entre sources de trafic',
    dimensions: ['utm_source', 'utm_medium', 'utm_campaign', 'device']
  },
  {
    title: 'Canaux',
    description: 'Vue de la performance globale par canal',
    dimensions: ['channel_group', 'channel', 'utm_campaign', 'device']
  },
  {
    title: 'Pages d\'entrée',
    description: 'Analyse de la qualité du contenu par source',
    dimensions: ['landing_path', 'utm_source', 'device']
  },
  {
    title: 'Trafic référent',
    description: 'Comprendre la qualité des sites référents',
    dimensions: ['referrer_domain', 'referrer_path', 'landing_path']
  },
  {
    title: 'Appareils & technologies',
    description: 'Indicateurs de performance techniques',
    dimensions: ['device', 'browser', 'os', 'connection_type']
  },
  {
    title: 'Schémas temporels',
    description: 'Meilleurs moments pour l\'engagement',
    dimensions: ['day_of_week', 'hour', 'is_weekend']
  },
  {
    title: 'Géographie',
    description: 'Engagement par pays et région',
    dimensions: ['country', 'region', 'city', 'timezone']
  }
]

interface ExploreTemplatesProps {
  onSelectTemplate: (dimensions: string[], filters?: Filter[]) => void
  onOpenAssistant?: () => void
  customDimensionLabels?: CustomDimensionLabels | null
}

export function ExploreTemplates({
  onSelectTemplate,
  onOpenAssistant,
  customDimensionLabels
}: ExploreTemplatesProps) {
  const [isCustomModalOpen, setIsCustomModalOpen] = useState(false)

  const handleTemplateClick = (template: ExploreTemplate) => {
    if (template.title === 'Rapport personnalisé') {
      setIsCustomModalOpen(true)
    } else if (template.title === 'Demander à l\'IA') {
      onOpenAssistant?.()
    } else {
      onSelectTemplate(template.dimensions, template.filters)
    }
  }

  const handleCustomReportSubmit = (dimensions: string[]) => {
    setIsCustomModalOpen(false)
    onSelectTemplate(dimensions)
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {templates.map((template) => {
          const isCustom = template.title === 'Rapport personnalisé'
          const isAskAI = template.title === 'Demander à l\'IA'
          const card = (
            <Card
              key={template.title}
              className={`hover:shadow-md transition-shadow cursor-pointer ${isAskAI ? 'border-0 rounded-md h-full' : ''}`}
              onClick={() => handleTemplateClick(template)}
              styles={{
                body: { padding: '16px', display: 'flex', flexDirection: 'column', height: '100%' }
              }}
            >
            <div className="flex-1">
              <h3 className="text-sm font-semibold m-0 mb-2 flex items-center gap-1.5">
                {isAskAI && <Sparkles size={16} className="text-yellow-500" />}
                {template.title}
              </h3>
              <p className="text-sm text-gray-500 mb-3">{template.description}</p>
              {template.dimensions.length > 0 && (
                <div className="mb-3 flex flex-col gap-1">
                  {template.dimensions.map((dim) => (
                    <Tag key={dim} color="blue" bordered={false} className="mr-0 w-fit">
                      {getDimensionLabel(dim, customDimensionLabels)}
                    </Tag>
                  ))}
                </div>
              )}
              {template.filters && template.filters.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs text-gray-400 mb-1">Avec :</div>
                  {template.filters.map((filter, idx) => (
                    <Tag key={idx} color="orange" bordered={false} className="mr-0 w-fit">
                      <span className="font-medium">{getDimensionLabel(filter.dimension, customDimensionLabels)}</span>
                      <span className="mx-1">{operatorLabels[filter.operator] || filter.operator}</span>
                      {filter.values && filter.values.length > 0 && (
                        <span className="font-medium">{filter.values.join(', ')}</span>
                      )}
                    </Tag>
                  ))}
                </div>
              )}
            </div>
            <Button
              type="primary"
              ghost
              block
              onClick={(e) => {
                e.stopPropagation()
                handleTemplateClick(template)
              }}
            >
              {isCustom ? 'Créer le mien' : isAskAI ? 'Ouvrir l\'assistant' : 'Sélectionner'}
            </Button>
          </Card>
          )

          return isAskAI ? (
            <div
              key={template.title}
              className="p-[2px] rounded-[10px] bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400"
            >
              {card}
            </div>
          ) : (
            card
          )
        })}
      </div>

      <BreakdownModal
        open={isCustomModalOpen}
        onCancel={() => setIsCustomModalOpen(false)}
        onSubmit={handleCustomReportSubmit}
        customDimensionLabels={customDimensionLabels}
        title="Créer un rapport personnalisé"
        submitText="Générer le rapport"
      />
    </>
  )
}
