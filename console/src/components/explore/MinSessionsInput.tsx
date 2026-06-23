import { useState } from 'react'
import { Button, InputNumber, Popover, Space, Tag, Tooltip } from 'antd'

interface MinSessionsInputProps {
  value: number
  onChange: (value: number) => void
}

export function MinSessionsInput({ value, onChange }: MinSessionsInputProps) {
  const [isPopoverVisible, setIsPopoverVisible] = useState(false)
  const [tempValue, setTempValue] = useState(value)

  const handleValueChange = (newValue: number | null) => {
    if (newValue !== null) {
      setTempValue(newValue)
    }
  }

  const applyChange = () => {
    onChange(tempValue)
    setIsPopoverVisible(false)
  }

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setTempValue(value)
    }
    setIsPopoverVisible(open)
  }

  const popoverContent = (
    <div className="w-48">
      <InputNumber
        min={1}
        max={100000}
        value={tempValue}
        onChange={handleValueChange}
        className="w-full mb-2"
      />
      <Button type="primary" onClick={applyChange} block>
        Appliquer
      </Button>
    </div>
  )

  return (
    <Tooltip title="Définir le seuil minimum de visites">
      <Popover
        content={popoverContent}
        title="Visites minimum"
        trigger="click"
        open={isPopoverVisible}
        onOpenChange={handleOpenChange}
        placement="bottom"
      >
        <Button type="text" size="small">
          <Space>
            Avec au moins
            <Tag color="purple" style={{ marginRight: 0 }}>
              {value}
            </Tag>
            visites
          </Space>
        </Button>
      </Popover>
    </Tooltip>
  )
}
