import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { Calendar, momentLocalizer } from 'react-big-calendar'
import moment from 'moment'
import 'react-big-calendar/lib/css/react-big-calendar.css'
import {
  AlertTriangle,
  CalendarDays,
  Download,
  FileUp,
  Plus,
  Settings,
  ShieldAlert,
  Sparkles,
  ListOrdered,
  Wand2,
} from 'lucide-react'
import jsPDF from 'jspdf'
import autoTable from 'jspdf-autotable'
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

const localizer = momentLocalizer(moment)
const API_URL = 'https://coursepulse-5i2t.onrender.com/upload-syllabi'

function isoDateDaysFromToday(daysFromToday) {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + daysFromToday)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const mockDemoData = [
  {
    course_name: 'PSY220 — Social Psychology',
    assignment_name: 'Midterm Test',
    due_date: isoDateDaysFromToday(10),
    tentative_date_text: null,
    weight_or_importance: 'High',
  },
  {
    course_name: 'CHM136 — Organic Chemistry I',
    assignment_name: 'Lab Report 2',
    due_date: isoDateDaysFromToday(11),
    tentative_date_text: null,
    weight_or_importance: 'High',
  },
  {
    course_name: 'CSC207 — Software Design',
    assignment_name: 'Project Milestone 1',
    due_date: isoDateDaysFromToday(13),
    tentative_date_text: null,
    weight_or_importance: 'Medium',
  },
  {
    course_name: 'POL101 — Intro to Politics',
    assignment_name: 'Reflection Post #3',
    due_date: isoDateDaysFromToday(14),
    tentative_date_text: null,
    weight_or_importance: 'Low',
  },
  {
    course_name: 'BIO130 — Cell & Systems Biology',
    assignment_name: 'Quiz: Unit 2',
    due_date: isoDateDaysFromToday(16),
    tentative_date_text: null,
    weight_or_importance: 'Medium',
  },
  {
    course_name: 'MAT137 — Calculus',
    assignment_name: 'Problem Set 4',
    due_date: isoDateDaysFromToday(18),
    tentative_date_text: null,
    weight_or_importance: 'Medium',
  },
  {
    course_name: 'ENG140 — Literature',
    assignment_name: 'Essay Topic Approval',
    due_date: null,
    tentative_date_text: 'End of month (TBD)',
    weight_or_importance: 'Low',
  },
]

function downloadCalendar(base64String) {
  if (!base64String) return
  const binary = atob(base64String)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: 'text/calendar' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'coursepulse_calendar.ics'
  a.click()
  URL.revokeObjectURL(url)
}

function cx(...classes) {
  return classes.filter(Boolean).join(' ')
}

function weightTone(weight) {
  const w = (weight || '').toLowerCase()
  if (w === 'high') return 'bg-rose-500/15 text-rose-200 ring-rose-500/25'
  if (w === 'medium') return 'bg-amber-500/15 text-amber-200 ring-amber-500/25'
  return 'bg-emerald-500/10 text-emerald-200 ring-emerald-500/20'
}

function onlyValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime())
}

function toLocalDate(yyyyMmDd) {
  // Avoid timezone shifting from `new Date("YYYY-MM-DD")` (parsed as UTC).
  const [y, m, d] = String(yyyyMmDd).split('-').map((x) => Number.parseInt(x, 10))
  if (!y || !m || !d) return new Date(String(yyyyMmDd))
  return new Date(y, m - 1, d)
}

function isPast(dateString) {
  if (!dateString) return false
  const d = toLocalDate(dateString)
  if (!onlyValidDate(d)) return false
  const today = new Date()
  d.setHours(0, 0, 0, 0)
  today.setHours(0, 0, 0, 0)
  return d.getTime() < today.getTime()
}

function weekRangeFromISO(year, week) {
  // ISO week: Monday is first day. Use Jan 4th anchor to find week 1 Monday.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = jan4.getUTCDay() || 7
  const week1Mon = new Date(jan4)
  week1Mon.setUTCDate(jan4.getUTCDate() - (day - 1))
  const start = new Date(week1Mon)
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7)
  const end = new Date(start)
  end.setUTCDate(start.getUTCDate() + 6)
  return { start, end }
}

function isoWeekYear(dateObj) {
  const d = new Date(Date.UTC(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
  return { year: d.getUTCFullYear(), week: weekNo }
}

function calculateDangerWeeksClient(assignments) {
  const byWeek = new Map()
  for (const a of assignments || []) {
    if (!a?.due_date) continue
    const d = toLocalDate(a.due_date)
    if (!onlyValidDate(d)) continue
    const { year, week } = isoWeekYear(d)
    const key = `${year}-${week}`
    const cur = byWeek.get(key) || { year, week, assignments: [] }
    cur.assignments.push(a)
    byWeek.set(key, cur)
  }

  const out = []
  for (const v of byWeek.values()) {
    const highCount = v.assignments.filter((x) => String(x?.weight_or_importance || '').trim() === 'High').length
    if (highCount >= 2 || v.assignments.length > 4) out.push(v)
  }
  return out.sort((a, b) => (a.year - b.year) || (a.week - b.week))
}

function mapAssignmentsToEvents(assignments) {
  return (assignments || [])
    .filter((item) => item?.due_date)
    .map((item) => ({
      title: shortTitleForCalendar(item),
      start: toLocalDate(item.due_date),
      end: toLocalDate(item.due_date),
      allDay: true,
      resource: item,
    }))
    .filter((e) => onlyValidDate(e.start))
}

function startOfWeekMonday(dateObj) {
  const d = new Date(dateObj)
  d.setHours(0, 0, 0, 0)
  const day = d.getDay() // 0=Sun
  const diff = (day === 0 ? -6 : 1) - day // shift to Monday
  d.setDate(d.getDate() + diff)
  return d
}

function buildWeeklyWorkloadData(calendarEvents) {
  const scores = { high: 3, medium: 2, low: 1 }
  const map = new Map()

  for (const ev of calendarEvents || []) {
    const start = ev?.start
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) continue
    const weekStart = startOfWeekMonday(start)
    const key = weekStart.toISOString().slice(0, 10)
    const w = String(ev?.resource?.weight_or_importance || 'Low').toLowerCase()
    const val = scores[w] ?? 1
    map.set(key, (map.get(key) || 0) + val)
  }

  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([weekStart, score]) => ({ weekStart, score }))
}

function shortTitleForCalendar(item) {
  const name = String(item?.assignment_name || '').trim()
  if (!name) return 'Assignment'

  const courseRaw = String(item?.course_name || '').trim()
  const courseShort = courseRaw
    ? (courseRaw.match(/[A-Za-z]{2,}\s*\d{2,}/)?.[0] || courseRaw.split(/\s+/)[0]).slice(0, 12)
    : 'Course'

  // Common patterns so important differentiators (like 1 vs 2) remain visible
  const midterm = name.match(/\bmidterm\b.*?(\d+)\b/i)
  if (midterm) return `${courseShort}: Midterm ${midterm[1]}`
  if (/\bmidterm\b/i.test(name)) return `${courseShort}: Midterm`
  if (/\bfinal\b/i.test(name)) return `${courseShort}: Final`
  if (/\bquiz\b/i.test(name)) return name.replace(/\s+/g, ' ').slice(0, 16)

  // Otherwise keep it compact for month cells
  const short = name.replace(/\s+/g, ' ').slice(0, 18)
  return `${courseShort}: ${short}`
}

function App() {
  const [files, setFiles] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('calendar')
  const [calendarDate, setCalendarDate] = useState(new Date())
  const [calendarView, setCalendarView] = useState('month')
  const [isDragOver, setIsDragOver] = useState(false)
  const [loadingHint, setLoadingHint] = useState('Warming up the parser…')

  const [lifeEvents, setLifeEvents] = useState([
    { name: 'Basketball Practice', day: 'Tuesday' },
    { name: 'Valorant Tournament', day: 'Friday' },
  ])

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [newAssignment, setNewAssignment] = useState({
    course_name: '',
    assignment_name: '',
    due_date: '',
    weight_or_importance: 'Medium',
  })
  const [manualAssignments, setManualAssignments] = useState([])

  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [newLifeEvent, setNewLifeEvent] = useState({ name: '', day: 'Monday' })

  const fileInputRef = useRef(null)
  const filesRef = useRef([])
  filesRef.current = files

  useEffect(() => {
    if (!isLoading) return
    const hints = [
      'Warming up the parser…',
      'Reading syllabus text…',
      'Extracting deadlines…',
      'Normalizing dates & importance…',
      'Detecting danger weeks…',
      'Building your calendar view…',
    ]
    let i = 0
    setLoadingHint(hints[0])
    const t = setInterval(() => {
      i = (i + 1) % hints.length
      setLoadingHint(hints[i])
    }, 1100)
    return () => clearInterval(t)
  }, [isLoading])

  const [calendarEvents, setCalendarEvents] = useState([])

  const dangerWeeks = result?.danger_weeks ?? []
  const icsBase64 = result?.ics_base64 ?? ''
  const weeklyWorkloadData = useMemo(() => buildWeeklyWorkloadData(calendarEvents), [calendarEvents])

  const assignments = useMemo(() => {
    const fromApi = result?.assignments ?? []
    return [...fromApi, ...manualAssignments]
  }, [result, manualAssignments])
  const sortedAssignments = useMemo(() => {
    return [...assignments].sort((a, b) => String(a?.due_date || '').localeCompare(String(b?.due_date || '')))
  }, [assignments])

  useEffect(() => {
    setCalendarEvents(mapAssignmentsToEvents(assignments))
  }, [assignments])

  const loadDemoData = () => {
    const danger_weeks = calculateDangerWeeksClient(mockDemoData)
    setError(null)
    setResult({ assignments: mockDemoData, danger_weeks, ics_base64: '' })
    setActiveTab('calendar')
    setCalendarEvents(mapAssignmentsToEvents(mockDemoData))
  }

  const downloadTimelinePdf = () => {
    const doc = new jsPDF({ unit: 'pt', format: 'letter' })
    const now = new Date()
    const title = 'CoursePulse — Master Timeline'

    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.text(title, 40, 48)

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(10)
    doc.setTextColor(100)
    doc.text(`Generated ${now.toLocaleString()}`, 40, 66)
    doc.setTextColor(0)

    const rows = (sortedAssignments || []).map((a) => {
      const dateText = a?.due_date ? String(a.due_date) : 'TBD'
      const tentative = a?.due_date ? '' : String(a?.tentative_date_text || '').trim()
      return [
        dateText,
        String(a?.course_name || ''),
        String(a?.assignment_name || ''),
        String(a?.weight_or_importance || ''),
        tentative,
      ]
    })

    autoTable(doc, {
      startY: 86,
      head: [['Date', 'Course', 'Assignment', 'Weight', 'Notes']],
      body: rows.length ? rows : [['—', '—', 'No assignments found', '—', '—']],
      styles: {
        font: 'helvetica',
        fontSize: 9,
        cellPadding: 6,
        valign: 'top',
        lineColor: [229, 231, 235],
        lineWidth: 0.5,
      },
      headStyles: {
        fillColor: [248, 250, 252],
        textColor: [15, 23, 42],
        fontStyle: 'bold',
        lineColor: [229, 231, 235],
        lineWidth: 0.5,
      },
      alternateRowStyles: { fillColor: [250, 250, 250] },
      columnStyles: {
        0: { cellWidth: 70 },
        1: { cellWidth: 90 },
        2: { cellWidth: 230 },
        3: { cellWidth: 55 },
        4: { cellWidth: 'auto' },
      },
      didDrawPage: (data) => {
        const pageCount = doc.getNumberOfPages()
        const pageNumber = doc.getCurrentPageInfo().pageNumber
        doc.setFontSize(9)
        doc.setTextColor(148)
        doc.text(`Page ${pageNumber} of ${pageCount}`, data.settings.margin.left, doc.internal.pageSize.height - 24)
        doc.setTextColor(0)
      },
    })

    doc.save('coursepulse_timeline.pdf')
  }

  const setFilesFromList = (fileList) => {
    const selected = Array.from(fileList || []).filter((f) => {
      const name = String(f?.name || '').toLowerCase()
      const type = String(f?.type || '').toLowerCase()
      const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : ''

      if (ext === '.pdf' || type === 'application/pdf') return true
      if (ext === '.docx' || type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return true
      if (type.startsWith('image/')) return true
      if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) return true
      return false
    })
    setFiles(selected)
    setError(null)
    if (selected.length === 0) setResult(null)
  }

  const analyze = async () => {
    const currentFiles = filesRef.current
    if (!currentFiles || currentFiles.length === 0) {
      setError('Drop at least one PDF to analyze.')
      return
    }
    setIsLoading(true)
    setError(null)
    setResult(null)
    try {
      const formData = new FormData()
      currentFiles.forEach((f) => formData.append('files', f))
      const { data } = await axios.post(`${API_URL}/upload-syllabi/`, formData)
      setResult(data && typeof data === 'object' ? data : { assignments: [], danger_weeks: [], ics_base64: '' })
      setActiveTab('calendar')
    } catch (err) {
      let message = 'Something went wrong. Please try again.'
      if (err.code === 'ERR_NETWORK') {
        message = 'Unable to connect to the cloud backend.'
      } else if (err.response?.status === 429) {
        message =
          'Daily API limit reached to protect free-tier quotas. Please click "Load Demo Data" to explore the dashboard!'
      } else if (err.response?.data?.detail) {
        const d = err.response.data.detail
        message = Array.isArray(d) ? (d[0]?.msg || JSON.stringify(d)) : String(d)
      } else if (err.message) {
        message = err.message
      }
      setError(message)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    // Jump calendar to first event date for better first impression.
    if (calendarEvents.length > 0) {
      const first = calendarEvents
        .map((e) => e.start)
        .filter(onlyValidDate)
        .sort((a, b) => a.getTime() - b.getTime())[0]
      if (first) setCalendarDate(first)
    }
  }, [calendarEvents])

  const isDashboard = result !== null
  const totalAssignments = assignments.length
  const totalDangerWeeks = dangerWeeks.length

  const dangerHighOnly = useMemo(() => {
    return (dangerWeeks || []).map((dw) => ({
      ...dw,
      highAssignments: (dw.assignments || []).filter(
        (a) => String(a?.weight_or_importance || '').toLowerCase() === 'high'
      ),
    }))
  }, [dangerWeeks])

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-slate-800">
      {!isDashboard && (
        <div className="min-h-screen flex items-center justify-center px-6 py-10">
          <div className="w-full max-w-4xl">
            <div className="text-center">
              <h1 className="text-4xl font-bold tracking-tight">CoursePulse</h1>
              <p className="mt-2 text-slate-500">
                Drop your syllabi. We build your calendar and find your overlapping deadlines.
              </p>
            </div>

            <div className="mt-10 rounded-2xl border border-gray-200 bg-white p-8">
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf, image/*, .docx, application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                className="sr-only"
                onChange={(e) => setFilesFromList(e?.target?.files)}
                onClick={(e) => e.stopPropagation()}
              />

              <div
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragOver(true)
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault()
                  setIsDragOver(false)
                  setFilesFromList(e.dataTransfer.files)
                }}
                onClick={() => fileInputRef.current?.click()}
                className={cx(
                  'rounded-2xl border-2 border-dashed border-gray-200 bg-white',
                  'p-10 md:p-14 flex flex-col items-center justify-center text-center',
                  'transition-colors cursor-pointer',
                  isDragOver ? 'border-slate-300 bg-gray-50' : 'hover:bg-gray-50'
                )}
              >
                <div className="h-12 w-12 rounded-full bg-gray-100 flex items-center justify-center">
                  <FileUp className="h-5 w-5 text-slate-500" />
                </div>
                <div className="mt-5 text-sm font-medium text-slate-700">
                  Drop your syllabus PDFs, Word Docs, or schedule screenshots here
                </div>
                <div className="mt-1 text-xs text-slate-400">or click to browse</div>

                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    fileInputRef.current?.click()
                  }}
                  className="mt-5 inline-flex items-center justify-center rounded-md border border-gray-200 bg-gray-100 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-gray-200 transition-colors"
                >
                  Browse Files
                </button>

                {files.length > 0 && (
                  <div className="mt-4 text-xs text-slate-500">
                    {files.length} file{files.length > 1 ? 's' : ''} selected
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={analyze}
                disabled={isLoading || files.length === 0}
                className={cx(
                  'mt-8 w-full rounded-xl px-6 py-4 text-sm font-semibold text-white',
                  'bg-slate-600 hover:bg-slate-700 transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                {isLoading ? (
                  <span className="flex flex-col items-center gap-1">
                    <span className="animate-pulse">Analyzing Syllabi via AI…</span>
                    <span className="text-xs font-medium text-white/80">{loadingHint}</span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 justify-center">
                    <FileUp className="h-4 w-4" />
                    Analyze Syllabus
                  </span>
                )}
              </button>

              <button
                type="button"
                onClick={loadDemoData}
                disabled={isLoading}
                className={cx(
                  'mt-3 w-full rounded-xl px-6 py-3 text-sm font-semibold',
                  'border border-gray-200 bg-white text-slate-700 hover:bg-gray-50 transition-colors',
                  'disabled:opacity-50 disabled:cursor-not-allowed'
                )}
              >
                Load Demo Data
              </button>

              {isLoading && (
                <div className="mt-4 rounded-xl border border-gray-200 bg-white p-4 text-sm text-slate-600">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-semibold text-slate-800">Working on it…</div>
                    <div className="text-xs text-slate-500">
                      {files.length} file{files.length === 1 ? '' : 's'}
                    </div>
                  </div>
                  <div className="mt-1 text-slate-500">{loadingHint}</div>
                  <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full w-1/2 animate-pulse rounded-full bg-slate-300" />
                  </div>
                </div>
              )}

              {error && (
                <div className="mt-6 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {error}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isDashboard && (
        <div className="min-h-screen flex flex-col">
          <header className="border-b border-gray-200 bg-white">
            <div className="mx-auto max-w-7xl px-6 py-4 flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setResult(null)
                    setFiles([])
                    setError(null)
                  }}
                  className="rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-xs font-semibold text-slate-700 hover:bg-gray-200 transition-colors"
                >
                  ← New Analysis
                </button>
                <div className="font-semibold text-slate-800">CoursePulse</div>
              </div>

              <button
                type="button"
                onClick={() => downloadCalendar(icsBase64)}
                disabled={!icsBase64}
                className="inline-flex items-center gap-2 rounded-md bg-slate-600 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Download className="h-4 w-4" />
                Export to Google Calendar (.ics)
              </button>

              <button
                type="button"
                onClick={loadDemoData}
                disabled={isLoading}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Wand2 className="h-4 w-4" />
                Load Demo Data
              </button>

              <button
                type="button"
                onClick={downloadTimelinePdf}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-gray-50 transition-colors"
              >
                <ListOrdered className="h-4 w-4" />
                Download Timeline (PDF)
              </button>

              <button
                type="button"
                onClick={() => setIsSettingsOpen(true)}
                className="inline-flex items-center gap-2 rounded-md border border-gray-200 bg-gray-100 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-gray-200 transition-colors"
              >
                <Settings className="h-4 w-4" />
                Settings &amp; Sync
              </button>

              <button
                type="button"
                onClick={() => setIsModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
              >
                <Plus className="h-4 w-4" />
                Add Deadline
              </button>
            </div>
          </header>

          <main className="mx-auto max-w-7xl w-full flex-1 px-6 py-6">
            <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6">
              <aside className="space-y-6">
                <div className="rounded-2xl border border-red-200 bg-red-50 p-6">
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 h-8 w-8 rounded-full bg-white/60 flex items-center justify-center border border-red-200">
                      <AlertTriangle className="h-4 w-4 text-red-500" />
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-800">Danger Week</div>
                      <div className="text-xs text-slate-500">
                        {dangerWeeks?.[0]
                          ? `Week ${dangerWeeks[0].week} • ${dangerWeeks[0].year}`
                          : 'No danger weeks detected'}
                      </div>
                    </div>
                  </div>

                  {dangerWeeks?.[0]?.assignments?.length > 0 ? (
                    <div className="mt-5 space-y-3">
                      {dangerWeeks[0].assignments.slice(0, 3).map((a, i) => (
                        <div key={i} className="rounded-xl border border-gray-200 bg-white p-4">
                          <div className="text-sm font-semibold text-slate-800">
                            {a.assignment_name}
                          </div>
                          <div className="mt-1 text-xs text-slate-500 flex items-center justify-between">
                            <span>{a.course_name}</span>
                            <span>{a.due_date}</span>
                          </div>
                        </div>
                      ))}
                      <div className="pt-2 text-xs text-slate-500">
                        {dangerWeeks[0].assignments.length} item(s) contributing
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 text-sm text-slate-500">
                      You’re looking good—no high overlap weeks flagged.
                    </div>
                  )}
                </div>

                <div className="rounded-2xl border border-gray-200 bg-white p-6">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-slate-500" />
                    <div className="text-sm font-semibold text-slate-800">Upcoming Deadlines</div>
                  </div>

                  <div className="mt-4 space-y-4">
                    {sortedAssignments.slice(0, 6).map((a, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <div className="mt-2 h-2 w-2 rounded-full bg-slate-400" />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-slate-800 truncate">
                            {a.assignment_name}
                          </div>
                          <div className="mt-1 text-xs text-slate-500">
                            {a.course_name} • {a.due_date}
                          </div>
                        </div>
                      </div>
                    ))}

                    {sortedAssignments.length === 0 && (
                      <div className="text-sm text-slate-500">No assignments found.</div>
                    )}
                  </div>
                </div>
              </aside>

              <section className="rounded-2xl border border-gray-200 bg-white p-6">
                <div className="flex items-center justify-between gap-3 mb-4">
                  <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1">
                    <button
                      type="button"
                      onClick={() => setActiveTab('calendar')}
                      className={cx(
                        'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                        activeTab === 'calendar'
                          ? 'bg-white border border-gray-200 text-slate-800'
                          : 'text-slate-500 hover:text-slate-700'
                      )}
                    >
                      Calendar
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('timeline')}
                      className={cx(
                        'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                        activeTab === 'timeline'
                          ? 'bg-white border border-gray-200 text-slate-800'
                          : 'text-slate-500 hover:text-slate-700'
                      )}
                    >
                      Master Timeline
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('danger')}
                      className={cx(
                        'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                        activeTab === 'danger'
                          ? 'bg-white border border-gray-200 text-slate-800'
                          : 'text-slate-500 hover:text-slate-700'
                      )}
                    >
                      Danger Zone
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('heatmap')}
                      className={cx(
                        'px-3 py-1.5 text-xs font-semibold rounded-md transition-colors',
                        activeTab === 'heatmap'
                          ? 'bg-white border border-gray-200 text-slate-800'
                          : 'text-slate-500 hover:text-slate-700'
                      )}
                    >
                      Workload Heatmap
                    </button>
                  </div>
                  <div className="text-xs text-slate-500">
                    {assignments.length} total deadlines
                  </div>
                </div>

                {activeTab === 'calendar' && (
                  <>
                    {calendarEvents.length === 0 ? (
                      <div className="min-h-[620px] grid place-items-center text-sm text-slate-500">
                        No events to display yet.
                      </div>
                    ) : (
                      <div className="h-[620px]">
                        <Calendar
                          localizer={localizer}
                          events={calendarEvents}
                          date={calendarDate}
                          onNavigate={setCalendarDate}
                          view={calendarView}
                          onView={setCalendarView}
                          startAccessor="start"
                          endAccessor="end"
                          eventPropGetter={(event) => {
                            const past = isPast(event?.resource?.due_date)
                            if (past) {
                              return {
                                style: {
                                  backgroundColor: '#E5E7EB',
                                  border: '1px solid #D1D5DB',
                                  color: '#374151',
                                  borderRadius: 9999,
                                  padding: '2px 8px',
                                  fontSize: 12,
                                  fontWeight: 600,
                                  lineHeight: 1.2,
                                  whiteSpace: 'normal',
                                  overflow: 'hidden',
                                  textOverflow: 'clip',
                                  boxShadow: 'none',
                                },
                              }
                            }

                            const weight = String(event?.resource?.weight_or_importance || '').toLowerCase()
                            const bg =
                              weight === 'high'
                                ? '#FEE2E2'
                                : weight === 'medium'
                                  ? '#FEF3C7'
                                  : '#DCFCE7'
                            const border =
                              weight === 'high'
                                ? '#FCA5A5'
                                : weight === 'medium'
                                  ? '#FCD34D'
                                  : '#86EFAC'
                            const color =
                              weight === 'high'
                                ? '#7F1D1D'
                                : weight === 'medium'
                                  ? '#78350F'
                                  : '#14532D'
                            return {
                              style: {
                                backgroundColor: bg,
                                border: `1px solid ${border}`,
                                color,
                                borderRadius: 9999,
                                padding: '2px 8px',
                                fontSize: 12,
                                fontWeight: 600,
                                lineHeight: 1.2,
                                whiteSpace: 'normal',
                                overflow: 'hidden',
                                textOverflow: 'clip',
                                boxShadow: 'none',
                              },
                            }
                          }}
                          tooltipAccessor={(event) =>
                            `${event?.resource?.course_name || ''} ${event?.resource?.assignment_name || ''}`.trim()
                          }
                          style={{ height: '100%' }}
                        />
                      </div>
                    )}
                  </>
                )}

                {activeTab === 'timeline' && (
                  <>
                    {sortedAssignments.length === 0 ? (
                      <div className="min-h-[620px] grid place-items-center text-sm text-slate-500">
                        No assignments found.
                      </div>
                    ) : (
                      <div className="overflow-auto max-h-[620px]">
                        <div className="grid grid-cols-12 gap-3 px-2 pb-2 text-xs font-semibold text-slate-500">
                          <div className="col-span-3">Date</div>
                          <div className="col-span-3">Course</div>
                          <div className="col-span-4">Assignment</div>
                          <div className="col-span-2">Status</div>
                        </div>
                        <div className="space-y-2">
                          {sortedAssignments.map((a, idx) => {
                            const past = isPast(a.due_date)
                            return (
                              <div
                                key={idx}
                                className={cx(
                                  'grid grid-cols-12 gap-3 items-center rounded-xl border border-gray-200 bg-white px-4 py-3',
                                  past && 'opacity-50'
                                )}
                              >
                                <div className={cx('col-span-3 text-sm', past ? 'text-slate-500 line-through' : 'text-slate-800')}>
                                  {a.due_date ? (
                                    a.due_date
                                  ) : (
                                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                                      TBD: {a.tentative_date_text || 'TBD'}
                                    </span>
                                  )}
                                </div>
                                <div className={cx('col-span-3 text-sm', past ? 'text-slate-500 line-through' : 'text-slate-800')}>
                                  {a.course_name}
                                </div>
                                <div className={cx('col-span-4 text-sm', past ? 'text-slate-500 line-through' : 'text-slate-800')}>
                                  {a.assignment_name}
                                </div>
                                <div className="col-span-2 flex items-center justify-end gap-2">
                                  {!a.due_date ? (
                                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600">
                                      TBD
                                    </span>
                                  ) : past ? (
                                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-gray-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                                      Past
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center rounded-full border border-gray-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600">
                                      Upcoming
                                    </span>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </>
                )}

                {activeTab === 'danger' && (
                  <>
                    {dangerWeeks.length === 0 ? (
                      <div className="min-h-[620px] grid place-items-center text-sm text-slate-500">
                        No danger weeks detected.
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {dangerWeeks.map((dw, i) => {
                          const items = dw.assignments || []
                          const allPast = items.length > 0 && items.every((a) => isPast(a.due_date))
                          const year = Number(dw.year)
                          const week = Number(dw.week)
                          const hasIso = Number.isFinite(year) && Number.isFinite(week)
                          const range = hasIso ? weekRangeFromISO(year, week) : null
                          const rangeLabel = range
                            ? `${range.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${range.end.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`
                            : `Week ${dw.week} • ${dw.year}`

                          return (
                            <div
                              key={i}
                              className={cx(
                                'rounded-2xl border p-5',
                                allPast
                                  ? 'border-gray-200 bg-gray-50'
                                  : 'border-red-200 bg-red-50'
                              )}
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className={cx('text-sm font-semibold', allPast ? 'text-slate-700' : 'text-slate-800')}>
                                    {allPast ? 'Past Danger Week' : 'Danger Week'}
                                  </div>
                                  <div className="text-xs text-slate-500 mt-1">{rangeLabel}</div>
                                </div>
                                <span className={cx(
                                  'inline-flex items-center rounded-full border px-2 py-1 text-[11px] font-semibold',
                                  allPast ? 'border-gray-200 bg-white text-slate-600' : 'border-red-200 bg-white text-red-700'
                                )}>
                                  {items.length} items
                                </span>
                              </div>

                              <div className="mt-4 space-y-2">
                                {items.map((a, j) => (
                                  <div key={j} className="rounded-xl border border-gray-200 bg-white p-3">
                                    <div className="text-sm font-semibold text-slate-800">
                                      {a.assignment_name}
                                    </div>
                                    <div className="mt-1 text-xs text-slate-500 flex items-center justify-between">
                                      <span>{a.course_name}</span>
                                      <span>{a.due_date}</span>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}

                {activeTab === 'heatmap' && (
                  <div className="rounded-2xl border border-gray-200 bg-white p-6">
                    <div className="flex items-center justify-between mb-4">
                      <div className="text-sm font-semibold text-slate-800">Weekly Workload</div>
                      <div className="text-xs text-slate-500">High=3 • Medium=2 • Low=1</div>
                    </div>
                    <div className="h-[520px]">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={weeklyWorkloadData}>
                          <XAxis dataKey="weekStart" tick={{ fontSize: 12 }} />
                          <YAxis tick={{ fontSize: 12 }} />
                          <Tooltip />
                          <Bar dataKey="score" fill="#64748B" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                )}
              </section>
            </div>
          </main>
        </div>
      )}

      {isModalOpen && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 border border-gray-100">
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="text-lg font-semibold text-slate-800">Manual Quick-Add</div>
                <div className="text-sm text-slate-500">Add a deadline that wasn’t in the PDF.</div>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Cancel
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Course Name</label>
                <input
                  type="text"
                  value={newAssignment.course_name}
                  onChange={(e) => setNewAssignment((s) => ({ ...s, course_name: e.target.value }))}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  placeholder="e.g., CS 201"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Assignment Name</label>
                <input
                  type="text"
                  value={newAssignment.assignment_name}
                  onChange={(e) => setNewAssignment((s) => ({ ...s, assignment_name: e.target.value }))}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  placeholder="e.g., Midterm Exam 1"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Due Date</label>
                <input
                  type="date"
                  value={newAssignment.due_date}
                  onChange={(e) => setNewAssignment((s) => ({ ...s, due_date: e.target.value }))}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Weight</label>
                <select
                  value={newAssignment.weight_or_importance}
                  onChange={(e) => setNewAssignment((s) => ({ ...s, weight_or_importance: e.target.value }))}
                  className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                >
                  <option value="Low">Low</option>
                  <option value="Medium">Medium</option>
                  <option value="High">High</option>
                </select>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg border border-gray-200 bg-gray-100 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-gray-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const course = newAssignment.course_name.trim()
                  const name = newAssignment.assignment_name.trim()
                  const due = newAssignment.due_date
                  if (!course || !name) return

                  const item = {
                    course_name: course,
                    assignment_name: name,
                    due_date: due ? due : null,
                    tentative_date_text: due ? null : 'Manually Added - TBD',
                    weight_or_importance: newAssignment.weight_or_importance || 'Medium',
                  }

                  setManualAssignments((prev) => [...prev, item])
                  setNewAssignment({
                    course_name: '',
                    assignment_name: '',
                    due_date: '',
                    weight_or_importance: 'Medium',
                  })
                  setIsModalOpen(false)
                }}
                className="rounded-lg bg-slate-700 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800 transition-colors"
              >
                Save Deadline
              </button>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm flex items-center justify-center z-50 p-6">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg p-6 border border-gray-100">
            <div className="flex items-start justify-between gap-4 mb-6">
              <div>
                <div className="text-lg font-semibold text-slate-800">Settings &amp; Sync</div>
                <div className="text-sm text-slate-500">Connect calendars and add life balance guardrails.</div>
              </div>
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-700"
              >
                Close
              </button>
            </div>

            <div className="space-y-6">
              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="text-sm font-semibold text-slate-800 mb-2">Google Calendar</div>
                <button
                  type="button"
                  className="w-full rounded-lg bg-slate-700 px-4 py-3 text-sm font-semibold text-white hover:bg-slate-800 transition-colors"
                >
                  Connect Google Calendar (OAuth)
                </button>
              </div>

              <div className="rounded-xl border border-gray-200 bg-white p-5">
                <div className="text-sm font-semibold text-slate-800 mb-3">Safe Space Algorithm</div>
                <div className="space-y-2 mb-4">
                  {lifeEvents.map((ev, idx) => (
                    <div key={idx} className="flex items-center justify-between rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
                      <div className="text-sm text-slate-700">{ev.name}</div>
                      <div className="text-xs font-semibold text-slate-600">{ev.day}</div>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <input
                    type="text"
                    value={newLifeEvent.name}
                    onChange={(e) => setNewLifeEvent((s) => ({ ...s, name: e.target.value }))}
                    placeholder="Activity Name"
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  />
                  <select
                    value={newLifeEvent.day}
                    onChange={(e) => setNewLifeEvent((s) => ({ ...s, day: e.target.value }))}
                    className="w-full bg-gray-50 border border-gray-200 rounded-lg p-3 text-slate-800 focus:outline-none focus:ring-2 focus:ring-slate-200"
                  >
                    {['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const name = newLifeEvent.name.trim()
                    const day = newLifeEvent.day
                    if (!name) return
                    setLifeEvents((prev) => [...prev, { name, day }])
                    setNewLifeEvent({ name: '', day: 'Monday' })
                  }}
                  className="mt-3 w-full rounded-lg border border-gray-200 bg-gray-100 px-4 py-3 text-sm font-semibold text-slate-700 hover:bg-gray-200 transition-colors"
                >
                  Add Guardrail
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App
