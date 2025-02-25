import React from 'react'

const Button = React.lazy(() => import('remote_app/Button'))
const Button1 = React.lazy(() => import('remote_app/Button1'))

const App = () => {
  return (
    <React.Suspense fallback="Loading App...">
      <h1>Rollup Host ESM</h1>
      <Button />
      <Button1 />
    </React.Suspense>
  )
}
export default App
