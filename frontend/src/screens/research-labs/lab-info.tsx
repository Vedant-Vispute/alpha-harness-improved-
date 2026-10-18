import { InfoIcon } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/ui/kit'
import { Dialog } from '@/ui/overlay'

export function LabInfoButton({ title, children }: { title: string; children: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`How ${title} works`}
        title={`How ${title} works`}
        onClick={() => setOpen(true)}
      >
        <InfoIcon />
      </Button>
      <Dialog open={open} onOpenChange={setOpen} title={`How ${title} works`}>
        <p className="text-body text-pretty text-ink-muted">{children}</p>
      </Dialog>
    </>
  )
}
