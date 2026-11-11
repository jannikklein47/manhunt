const routes = [
  {
    path: '/',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      { path: '', component: () => import('@/pages/IndexPage.vue') },
      { path: 'create', component: () => import('@/pages/CreatePage.vue') },
      { path: 'room/:code', component: () => import('@/pages/RoomPage.vue') },
      { path: 'replays', component: () => import('@/pages/ReplaysPage.vue') },
      { path: 'replays/:id', component: () => import('@/pages/ReplayPage.vue') },
      { path: 'leaderboard', component: () => import('@/pages/LeaderboardPage.vue') },
      { path: 'players/:name', component: () => import('@/pages/PlayerStatsPage.vue') },
    ],
  },

  // Always leave this as last one,
  // but you can also remove it
  {
    path: '/:catchAll(.*)*',
    component: () => import('@/pages/ErrorNotFound.vue'),
  },
]

export default routes
