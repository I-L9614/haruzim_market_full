import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error) {
    if (import.meta.env.DEV) console.error('Customer interface render error:', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="app-shell" dir="rtl">
          <section className="error-boundary-card" role="alert">
            <h1>אירעה תקלה בהצגת החנות</h1>
            <p>העגלה וההזמנה לא נמחקו. אפשר לטעון מחדש ולנסות שוב.</p>
            <button className="primary-btn" type="button" onClick={() => window.location.reload()}>טעינה מחדש</button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
