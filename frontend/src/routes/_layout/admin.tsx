import { useSuspenseQuery } from "@tanstack/react-query"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { Suspense } from "react"

import { NomadService, type UserPublic, UsersService } from "@/client"
import AddUser from "@/components/Admin/AddUser"
import { columns, type UserTableData } from "@/components/Admin/columns"
import { nomadUploadColumns } from "@/components/Admin/nomadUploadColumns"
import { DataTable } from "@/components/Common/DataTable"
import PendingUsers from "@/components/Pending/PendingUsers"
import useAuth from "@/hooks/useAuth"

function getUsersQueryOptions() {
  return {
    queryFn: () => UsersService.readUsers({ skip: 0, limit: 100 }),
    queryKey: ["users"],
  }
}

function getNomadUploadLogQueryOptions() {
  return {
    queryFn: () => NomadService.listNomadUploadLog({ skip: 0, limit: 100 }),
    queryKey: ["nomad-upload-log"],
  }
}

export const Route = createFileRoute("/_layout/admin")({
  component: Admin,
  beforeLoad: async () => {
    const user = await UsersService.readUserMe()
    if (!user.is_superuser) {
      throw redirect({
        to: "/",
      })
    }
  },
  head: () => ({
    meta: [
      {
        title: "Admin - FastAPI Template",
      },
    ],
  }),
})

function UsersTableContent() {
  const { user: currentUser } = useAuth()
  const { data: users } = useSuspenseQuery(getUsersQueryOptions())

  // The API can return an empty/partial body (e.g. proxy error page) — guard
  // rather than crashing the whole admin route on `undefined.map`.
  const tableData: UserTableData[] = (users?.data ?? []).map(
    (user: UserPublic) => ({
      ...user,
      isCurrentUser: currentUser?.id === user.id,
    }),
  )

  return <DataTable columns={columns} data={tableData} />
}

function UsersTable() {
  return (
    <Suspense fallback={<PendingUsers />}>
      <UsersTableContent />
    </Suspense>
  )
}

function NomadUploadLogContent() {
  const { data } = useSuspenseQuery(getNomadUploadLogQueryOptions())
  return <DataTable columns={nomadUploadColumns} data={data?.data ?? []} />
}

function NomadUploadLogTable() {
  return (
    <Suspense fallback={<PendingUsers />}>
      <NomadUploadLogContent />
    </Suspense>
  )
}

function Admin() {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Users</h1>
            <p className="text-muted-foreground">
              Manage user accounts and permissions
            </p>
          </div>
          <AddUser />
        </div>
        <UsersTable />
      </div>

      <div className="flex flex-col gap-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">NOMAD Uploads</h1>
          <p className="text-muted-foreground">
            Central log of every NOMAD upload. Failed uploads keep their file
            archive (downloadable) for one week.
          </p>
        </div>
        <NomadUploadLogTable />
      </div>
    </div>
  )
}
