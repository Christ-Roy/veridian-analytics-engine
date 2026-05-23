import { FloatButton, Tooltip } from 'antd'
import { CloseOutlined } from '@ant-design/icons'
import { Sparkles } from 'lucide-react'
import { useAssistantContext } from '../../contexts/AssistantContext'

export function AssistantButton() {
  const { isOpen, setIsOpen } = useAssistantContext()

  return (
    <Tooltip title={isOpen ? "Fermer l'assistant" : "Demander à l'IA de créer un rapport"} placement="left">
      <FloatButton
        icon={isOpen ? <CloseOutlined /> : <Sparkles size={22} color="white" />}
        type="primary"
        onClick={() => setIsOpen(!isOpen)}
        className="!w-12 !h-12 md:!w-14 md:!h-14 !right-4 !bottom-4 md:!right-6 md:!bottom-6 max-md:!hidden"
        style={{ zIndex: 50 }}
      />
    </Tooltip>
  )
}
