import { useMemo } from 'react'
import { Alert, Button } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { analyticsQueryOptions } from '../../lib/queries'
import { useAuth } from '../../lib/useAuth'
import type { AnalyticsQuery, AnalyticsResponse } from '../../types/analytics'

/** Extract major version number from semver string (e.g., "3.2.0" -> 3) */
function getMajorVersion(version: string): number | null {
  const match = version.match(/^(\d+)\./)
  return match ? parseInt(match[1], 10) : null
}

interface SdkVersionWarningProps {
  workspaceId: string
  timezone: string
}

export function SdkVersionWarning({ workspaceId, timezone }: SdkVersionWarningProps) {
  // Ceinture (lot B5) : jamais de bandeau « SDK obsolète » sur l'instance de
  // démo. La data mockée peut porter d'anciens sdk_version (re-seeds avant le
  // fix #1) et le bundle baked peut diverger d'APP_VERSION ; en démo on ne
  // veut sous aucun prétexte contredire le pitch « stack moderne ».
  const { isDemo } = useAuth()

  // Memoize query to prevent endless re-fetching
  const query = useMemo<AnalyticsQuery>(() => {
    const now = new Date()
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
    return {
      workspace_id: workspaceId,
      metrics: ['sessions'],
      dimensions: ['sdk_version'],
      dateRange: {
        start: yesterday.toISOString(),
        end: now.toISOString()
      },
      timezone,
      limit: 10
    }
  }, [workspaceId, timezone])

  const { data, isLoading } = useQuery(analyticsQueryOptions(query))

  // Gate démo : aucun bandeau « SDK obsolète » en mode démo (cf bloc ci-dessus).
  if (isDemo) return null

  if (isLoading || !data) return null

  // Extract sdk_version values from response
  const responseData = data as AnalyticsResponse
  const versions = (responseData.data as Record<string, unknown>[])
    .map((row) => row.sdk_version as string)
    .filter((v) => v && v !== '')

  // If no versions found, no sessions have been tracked
  if (versions.length === 0) return null

  // Only warn on major version mismatch (not minor/patch), AND only when we can
  // actually READ a semver major from the tracked versions. A non-semver
  // sdk_version (e.g. demo-seed tags `vrddemo-onboarding-1.0`, or a client's
  // custom/internal tracker label) yields major=null — we CANNOT conclude it is
  // "obsolete", so it must NOT trip the banner (false-positive seen prod on the
  // ASD demo workspace, where every event carries a `vrddemo-*` tag). Robust fix
  // independent of the IS_DEMO instance gate and of re-seeding.
  const currentVersion = __APP_VERSION__
  const currentMajor = getMajorVersion(currentVersion)

  const semverMajors = versions
    .map(getMajorVersion)
    .filter((m): m is number => m !== null)

  // No parseable semver version among the tracked ones → nothing to conclude.
  if (semverMajors.length === 0) return null

  // If any tracked semver version has the same major version, no warning needed.
  if (semverMajors.some((m) => m === currentMajor)) return null

  // Name the first OUTDATED semver version in the message (not an arbitrary
  // non-semver tag), so the banner points at a real version to act on.
  const outdatedExample =
    versions.find((v) => {
      const m = getMajorVersion(v)
      return m !== null && m !== currentMajor
    }) ?? versions[0]

  return (
    <Alert
      type="warning"
      className="mb-6!"
      message={
        <div className="flex items-center justify-between">
          <span>
            SDK obsolète détecté ({outdatedExample} → {currentVersion})
          </span>
          <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} search={{ section: 'sdk' }}>
            <Button type="link" size="small" className="p-0">
              Mettre à jour le SDK
            </Button>
          </Link>
        </div>
      }
    />
  )
}
